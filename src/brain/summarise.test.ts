import { describe, it, expect, vi } from 'vitest';
import { summarise, summaryPrompt, SUMMARY_MAX } from './summarise';

const ok = (reply: string) =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify({ reply }), { status: 200 }));

describe('summaryPrompt', () => {
  // The cap used to be "one screen, hard constraint". The summary paginates
  // now, so the ceiling exists to stop a summary becoming the article — and the
  // prompt asks for the length the argument needs rather than a fixed budget,
  // because writing to a fixed budget padded short pieces.
  it('states the ceiling without demanding the text fill it', () => {
    const p = summaryPrompt('T', 'A', 'body');
    expect(p).toContain(String(SUMMARY_MAX));
    expect(p).toContain('Ceiling');
    expect(p).toContain('Do not pad');
  });

  it('includes the title and author for context', () => {
    const p = summaryPrompt('Deep Work', 'Cal Newport', 'body');
    expect(p).toContain('Deep Work');
    expect(p).toContain('Cal Newport');
  });

  it('omits the author line entirely when there is none', () => {
    expect(summaryPrompt('T', null, 'body')).not.toContain('Author:');
  });

  // A 30k-char article in a JSON body is slow and unnecessary — the opening
  // carries the thesis.
  it('caps how much article it sends', () => {
    const p = summaryPrompt('T', null, 'x'.repeat(50_000));
    expect(p.length).toBeLessThan(10_000);
  });
});

describe('summarise', () => {
  it('returns the Brain reply, flagged as from the Brain', async () => {
    const r = await summarise('T', 'A', 'article text', { fetchImpl: ok('The gist.') as unknown as typeof fetch });
    expect(r).toEqual({ text: 'The gist.', fromBrain: true });
  });

  // The live board refuses an ask without a provider (400), and its default
  // mode hands Claude file and web tools. Article text is written by strangers.
  it('posts to the board ask endpoint on Claude, in tool-less text mode', async () => {
    const f = ok('x');
    await summarise('T', null, 'body', { fetchImpl: f as unknown as typeof fetch, base: 'http://b' });
    expect(f.mock.calls[0][0]).toBe('http://b/api/ask?provider=claude&mode=text');
    expect((f.mock.calls[0][1] as RequestInit).method).toBe('POST');
  });

  it('strips the markdown the glasses would print literally', async () => {
    const r = await summarise('T', null, 'body', {
      fetchImpl: ok('## Gist\n**Bold claim** and __more__.') as unknown as typeof fetch,
    });
    expect(r.text).toBe('Gist\nBold claim and more.');
  });

  // The model is ASKED for 450 chars, but the screen is a hard limit — an
  // overlong reply would print over the footer.
  it('trims a reply that ignores the limit', async () => {
    const r = await summarise('T', null, 'body', {
      fetchImpl: ok('word '.repeat(500)) as unknown as typeof fetch,
    });
    expect(r.text.length).toBeLessThanOrEqual(SUMMARY_MAX + 1);
  });

  // NEVER throws: the user is mid-flow deciding what to read, and an error
  // screen is worse than the article's own opening.
  it('falls back to an extract when the board is unreachable', async () => {
    const f = vi.fn().mockRejectedValue(new Error('no tailnet'));
    const r = await summarise('T', null, 'The article begins here.', {
      fetchImpl: f as unknown as typeof fetch,
    });
    expect(r.fromBrain).toBe(false);
    expect(r.text).toContain('The article begins here.');
  });

  it('falls back on a non-200 response', async () => {
    const f = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
    const r = await summarise('T', null, 'Body text.', { fetchImpl: f as unknown as typeof fetch });
    expect(r.fromBrain).toBe(false);
  });

  it('falls back on an empty reply rather than showing a blank screen', async () => {
    const r = await summarise('T', null, 'Body text.', {
      fetchImpl: ok('   ') as unknown as typeof fetch,
    });
    expect(r.fromBrain).toBe(false);
    expect(r.text).toContain('Body text.');
  });

  it('falls back on malformed JSON', async () => {
    const f = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }));
    const r = await summarise('T', null, 'Body text.', { fetchImpl: f as unknown as typeof fetch });
    expect(r.fromBrain).toBe(false);
  });
});
