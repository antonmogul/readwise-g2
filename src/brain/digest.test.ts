/**
 * Feed triage: prompt, parsing, and failing safely.
 *
 * This is model output crossing into a render path. Everything here is about
 * refusing to trust it — a stray code fence, a missing field or a truncated
 * reply must degrade to "no triage" (and plain grouping), never to a broken
 * screen or a thrown error on the daily surface.
 */

import { describe, it, expect, vi } from 'vitest';
import { digestPrompt, extractJson, parsePicks, triage, MAX_TRIAGE_ITEMS } from './digest';
import { MAX_SECTIONS, MAX_PER_SECTION } from '../readwise/digest';
import type { Doc } from '../readwise/client';

const doc = (over: Partial<Doc> & { id: string }): Doc => ({
  title: `Title ${over.id}`, author: null, site_name: 'The Verge', url: 'u',
  category: 'article', location: 'feed', reading_progress: 0, reading_time: '5 mins',
  saved_at: '2026-08-09T10:00:00Z', summary: null, ...over,
});

describe('digestPrompt', () => {
  it('sends id, publication and title for each item', () => {
    const p = digestPrompt([doc({ id: 'abc', title: 'A Headline', site_name: 'Wired' })]);
    expect(p).toContain('abc');
    expect(p).toContain('A Headline');
    expect(p).toContain('Wired');
  });

  it('states the section and item caps it expects back', () => {
    const p = digestPrompt([doc({ id: '1' })]);
    expect(p).toContain(String(MAX_SECTIONS));
    expect(p).toContain(String(MAX_PER_SECTION));
  });

  it('gives permission to return less — the point is to drop most of it', () => {
    const p = digestPrompt([doc({ id: '1' })]);
    expect(p).toMatch(/correct to return fewer/i);
  });

  it('caps how many titles it sends', () => {
    const many = Array.from({ length: 500 }, (_, i) => doc({ id: String(i) }));
    const lines = digestPrompt(many).split('\n').filter((l) => l.includes('\t'));
    expect(lines).toHaveLength(MAX_TRIAGE_ITEMS);
  });

  it('does not send article bodies — triage judges headlines', () => {
    const p = digestPrompt([doc({ id: '1' })]);
    expect(p).not.toContain('html_content');
  });
});

describe('extractJson', () => {
  it('parses a bare object', () => {
    expect(extractJson('{"sections":[]}')).toEqual({ sections: [] });
  });

  it('survives a code fence', () => {
    // Common enough that failing here would lose the digest to a backtick.
    expect(extractJson('```json\n{"sections":[]}\n```')).toEqual({ sections: [] });
  });

  it('survives a leading sentence', () => {
    expect(extractJson('Here you go:\n{"sections":[]}')).toEqual({ sections: [] });
  });

  it('returns null on unparseable output rather than throwing', () => {
    expect(extractJson('I could not do that.')).toBeNull();
    expect(extractJson('{"sections": [')).toBeNull();
    expect(extractJson('')).toBeNull();
  });
});

describe('parsePicks', () => {
  it('accepts a well-formed reply', () => {
    const out = parsePicks({ sections: [{ name: 'AI', ids: ['a'], note: 'why' }] });
    expect(out).toEqual([{ name: 'AI', ids: ['a'], note: 'why' }]);
  });

  it('skips sections missing a name or ids', () => {
    const out = parsePicks({ sections: [
      { name: 'Good', ids: ['a'] },
      { ids: ['b'] },
      { name: 'No ids' },
    ] });
    expect(out).toEqual([{ name: 'Good', ids: ['a'], note: null }]);
  });

  it('drops non-string ids rather than passing undefined down', () => {
    const out = parsePicks({ sections: [{ name: 'S', ids: ['a', 42, null] }] });
    expect(out![0].ids).toEqual(['a']);
  });

  it('returns null when nothing usable survives', () => {
    expect(parsePicks({ sections: [] })).toBeNull();
    expect(parsePicks({ sections: [{ name: 'S', ids: [] }] })).toBeNull();
    expect(parsePicks({ nope: true })).toBeNull();
    expect(parsePicks(null)).toBeNull();
    expect(parsePicks('a string')).toBeNull();
  });
});

describe('triage', () => {
  const docs = [doc({ id: 'a' }), doc({ id: 'b' })];
  const reply = (body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

  it('returns picks from a good reply', async () => {
    const f = reply({ reply: '{"sections":[{"name":"AI","ids":["a"]}]}' });
    const out = await triage(docs, { base: 'http://x', fetchImpl: f as unknown as typeof fetch });
    expect(out).toEqual([{ name: 'AI', ids: ['a'], note: null }]);
  });

  // Headlines are written by strangers: never to the board's tool-using mode,
  // and never without the provider the live board requires.
  it('asks the board on Claude, in tool-less text mode', async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ reply: '{"sections":[]}' }), { status: 200 }));
    await triage(docs, { base: 'http://x', fetchImpl: f as unknown as typeof fetch });
    expect(f.mock.calls[0][0]).toBe('http://x/api/ask?provider=claude&mode=text');
  });

  it('returns null on a server error rather than throwing', async () => {
    const f = vi.fn(async () => new Response('nope', { status: 500 }));
    expect(await triage(docs, { base: 'http://x', fetchImpl: f as unknown as typeof fetch }))
      .toBeNull();
  });

  it('returns null when the board is unreachable', async () => {
    // The digest is the daily surface — it must not go down with the tailnet.
    const f = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    expect(await triage(docs, { base: 'http://x', fetchImpl: f as unknown as typeof fetch }))
      .toBeNull();
  });

  it('returns null on unparseable output', async () => {
    const f = reply({ reply: 'I think you should read everything.' });
    expect(await triage(docs, { base: 'http://x', fetchImpl: f as unknown as typeof fetch }))
      .toBeNull();
  });

  it('does not call the board for an empty feed', async () => {
    const f = vi.fn();
    expect(await triage([], { base: 'http://x', fetchImpl: f as unknown as typeof fetch }))
      .toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});
