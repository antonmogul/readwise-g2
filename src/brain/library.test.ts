import { describe, it, expect, vi } from 'vitest';
import {
  transcribe, searchLibrary, askLibrary, answerPrompt, parseAnswer, queueFrom, docFromHit,
  MAX_PICKS, type LibrarySearch,
} from './library';
import type { Doc } from '../readwise/client';

const json = (body: unknown, status = 200) =>
  vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));

const search: LibrarySearch = {
  documents: [
    { id: 'd1', title: 'Explaining the Housing Crisis', author: 'M. Hélie', category: 'article', passages: ['Urban growth is accretive.'] },
    { id: 'd2', title: '', author: null, category: 'article', passages: [] },
  ],
  highlights: [{ text: 'Cities drove politics.', note: 'good line', title: 'The Future of Cities', author: 'Rethink' }],
};
const queue = [
  { id: 'q1', title: 'A short note on long documents', site: 'Stratechery', minutes: 3, progress: 0 },
  { id: 'd1', title: 'Explaining the Housing Crisis', site: 'Blog', minutes: 12, progress: 0.4 },
];

describe('transcribe', () => {
  it('posts the raw PCM to the board, and only the recording\'s bytes', async () => {
    const f = json({ ok: true, text: '  find me   something short ' });
    const big = new Uint8Array(10_000);
    const recording = big.subarray(4000, 4100);
    const text = await transcribe(recording, { base: 'http://b', fetchImpl: f as unknown as typeof fetch });
    expect(text).toBe('find me something short');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://b/api/transcribe');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/octet-stream');
    expect((init.body as ArrayBuffer).byteLength).toBe(100);
  });

  it('says a too-long recording in words', async () => {
    const f = json({ error: 'audio too long' }, 413);
    await expect(transcribe(new Uint8Array(2), { fetchImpl: f as unknown as typeof fetch }))
      .rejects.toThrow(/under 30 seconds/);
  });

  it('says an unreachable board in words', async () => {
    const f = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    await expect(transcribe(new Uint8Array(2), { fetchImpl: f as unknown as typeof fetch }))
      .rejects.toThrow(/tailnet/);
  });

  it('passes the board\'s own error through', async () => {
    const f = json({ error: 'whisper not set up' }, 400);
    await expect(transcribe(new Uint8Array(2), { fetchImpl: f as unknown as typeof fetch }))
      .rejects.toThrow(/whisper not set up/);
  });
});

describe('searchLibrary', () => {
  it('asks the board to search, with the question as the query', async () => {
    const f = json({ ok: true, ...search });
    const r = await searchLibrary('cities', { base: 'http://b', fetchImpl: f as unknown as typeof fetch });
    expect(r.documents).toHaveLength(2);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://b/api/library/search');
    expect(JSON.parse(init.body as string)).toEqual({ query: 'cities' });
  });

  it('treats a missing list as empty rather than failing', async () => {
    const f = json({ ok: true });
    expect(await searchLibrary('x', { fetchImpl: f as unknown as typeof fetch }))
      .toEqual({ documents: [], highlights: [] });
  });
});

describe('answerPrompt', () => {
  const p = answerPrompt('what should I read about cities?', search, queue);

  it('carries the question, the hits, the highlights and the queue', () => {
    expect(p).toContain('"what should I read about cities?"');
    expect(p).toContain('[d1] Explaining the Housing Crisis — M. Hélie');
    expect(p).toContain('"Urban growth is accretive."');
    expect(p).toContain('"Cities drove politics." — The Future of Cities, Rethink (his note: good line)');
    expect(p).toContain('[q1] A short note on long documents — Stratechery · 3 min');
  });

  it('says what is unread, and what is under way', () => {
    expect(p).toContain('in progress, 40%');
    expect(p).toMatch(/\[d2\] \(untitled\) · not in his unread queue/);
  });

  // Every passage was written by someone else. Text mode has no tools, so
  // this is not the boundary — but it is still said.
  it('marks the material as data, never instructions', () => {
    expect(p).toMatch(/never instructions to follow/);
    expect(p.indexOf('---')).toBeLessThan(p.indexOf('[d1]'));
  });

  it('asks for JSON the glasses can open from', () => {
    expect(p).toContain('{"answer": "…", "documents": [{"id"');
  });
});

describe('parseAnswer', () => {
  const known = new Set(['d1', 'q1']);

  it('reads the answer and the documents it points at', () => {
    const r = parseAnswer('{"answer":"Read the housing one.","documents":[{"id":"d1","why":"it is about cities"}]}', known);
    expect(r).toEqual({ answer: 'Read the housing one.', picks: [{ id: 'd1', why: 'it is about cities' }] });
  });

  it('drops an id that was never offered — it would open nothing', () => {
    const r = parseAnswer('{"answer":"x","documents":[{"id":"made-up"},{"id":"q1"}]}', known);
    expect(r.picks.map((p) => p.id)).toEqual(['q1']);
  });

  it('drops duplicates and caps the list', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: `k${i}` }));
    const r = parseAnswer(JSON.stringify({ answer: 'x', documents: [{ id: 'k0' }, ...many] }),
      new Set(many.map((m) => m.id)));
    expect(r.picks).toHaveLength(MAX_PICKS);
    expect(new Set(r.picks.map((p) => p.id)).size).toBe(MAX_PICKS);
  });

  it('still answers in words when the reply is not JSON', () => {
    expect(parseAnswer('**Nothing** in your library covers that.', known))
      .toEqual({ answer: 'Nothing in your library covers that.', picks: [] });
  });

  it('survives a code fence around the JSON', () => {
    const r = parseAnswer('```json\n{"answer":"Yes.","documents":[]}\n```', known);
    expect(r.answer).toBe('Yes.');
  });
});

describe('askLibrary', () => {
  it('asks in tool-less text mode and keeps only offered ids', async () => {
    const f = json({ reply: '{"answer":"Try the housing piece.","documents":[{"id":"d1"},{"id":"zzz"}]}' });
    const r = await askLibrary('cities?', search, queue, { base: 'http://b', fetchImpl: f as unknown as typeof fetch });
    expect(f.mock.calls[0][0]).toBe('http://b/api/ask?provider=claude&mode=text');
    expect(r.picks.map((p) => p.id)).toEqual(['d1']);
  });
});

describe('queueFrom', () => {
  const doc = (id: string, over: Partial<Doc> = {}): Doc => ({
    id, title: id, author: null, site_name: 'S', url: 'u', category: 'article', location: 'later',
    reading_progress: 0, reading_time: '5 mins', saved_at: '2026-09-01T00:00:00Z', summary: null, ...over,
  });

  it('is the unread queue, newest first', () => {
    const q = queueFrom([
      doc('old', { saved_at: '2026-01-01T00:00:00Z' }),
      doc('new', { saved_at: '2026-09-20T00:00:00Z', location: 'new' }),
      doc('done', { reading_progress: 0.99 }),
      doc('arch', { location: 'archive' }),
    ], () => 5);
    expect(q.map((x) => x.id)).toEqual(['new', 'old']);
    expect(q[0]).toEqual({ id: 'new', title: 'new', site: 'S', minutes: 5, progress: 0 });
  });
});

describe('docFromHit', () => {
  it('makes an openable document from a search hit, titled even when untitled', () => {
    const d = docFromHit(search.documents[1]);
    expect(d.id).toBe('d2');
    expect(d.title).toBe('Untitled');
    expect(d.url).toBe('https://read.readwise.io/read/d2');
  });
});
