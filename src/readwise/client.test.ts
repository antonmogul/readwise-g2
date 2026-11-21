import { describe, it, expect, vi } from 'vitest';
import {
  listQuery, listPage, listAll, fullText, archive, readingMinutes,
  ReadwiseError, explain, type ClientOptions, type Doc,
} from './client';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const opts = (fetchImpl: typeof fetch): ClientOptions => ({ token: 't0k', fetchImpl });

const doc = (over: Partial<Doc> & { id: string }): Doc => ({
  title: 'T', author: null, site_name: null, url: 'u', category: 'article',
  location: 'later', reading_progress: 0, reading_time: null,
  saved_at: '2026-08-06T10:00:00Z', summary: null, ...over,
});

describe('listQuery', () => {
  it('builds a query from the params given', () => {
    expect(listQuery({ location: 'later', category: 'article' }))
      .toBe('/list/?location=later&category=article');
  });

  it('omits everything unset', () => {
    expect(listQuery({})).toBe('/list/');
  });

  it('only sends withHtmlContent when true', () => {
    expect(listQuery({ id: 'x', withHtmlContent: true }))
      .toBe('/list/?id=x&withHtmlContent=true');
    expect(listQuery({ id: 'x', withHtmlContent: false })).toBe('/list/?id=x');
  });
});

describe('auth and errors', () => {
  it('sends the Token authorization header', async () => {
    const f = vi.fn().mockResolvedValue(json({ results: [], nextPageCursor: null }));
    await listPage(opts(f as unknown as typeof fetch), {});
    expect((f.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      Authorization: 'Token t0k',
    });
  });

  it('maps 401 to an auth error', async () => {
    const f = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    await expect(listPage(opts(f as unknown as typeof fetch), {}))
      .rejects.toMatchObject({ kind: 'auth' });
  });

  // 429 is expected, not exceptional — the whole app is designed around a
  // 20/min budget, so it gets its own kind and its own user-facing sentence.
  it('maps 429 to a rate error', async () => {
    const f = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    await expect(listPage(opts(f as unknown as typeof fetch), {}))
      .rejects.toMatchObject({ kind: 'rate' });
  });

  it('maps other failures to a server error', async () => {
    const f = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
    await expect(listPage(opts(f as unknown as typeof fetch), {}))
      .rejects.toMatchObject({ kind: 'server' });
  });

  it('reports malformed JSON rather than throwing a parse error', async () => {
    const f = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }));
    await expect(listPage(opts(f as unknown as typeof fetch), {}))
      .rejects.toMatchObject({ kind: 'data' });
  });

  it('maps a network failure to a network error', async () => {
    const f = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(listPage(opts(f as unknown as typeof fetch), {}))
      .rejects.toMatchObject({ kind: 'network' });
  });

  it('explains every failure kind as a sentence', () => {
    for (const kind of ['auth', 'rate', 'network', 'timeout', 'server', 'data'] as const) {
      expect(explain(new ReadwiseError('x', kind)).length).toBeGreaterThan(0);
    }
    expect(explain(new Error('unknown'))).toMatch(/went wrong/);
  });
});

describe('listAll', () => {
  it('follows the cursor across pages', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json({ results: [doc({ id: '1' })], nextPageCursor: 'c2' }))
      .mockResolvedValueOnce(json({ results: [doc({ id: '2' })], nextPageCursor: null }));
    const out = await listAll(opts(f as unknown as typeof fetch), { location: 'later' });
    expect(out.map((d) => d.id)).toEqual(['1', '2']);
    expect(f).toHaveBeenCalledTimes(2);
  });

  // The feed holds 10,000 items. An unbounded loop would burn the entire
  // 20/min budget and still not finish.
  it('stops at maxPages even when a cursor remains', async () => {
    // A fresh Response per call: a body can only be read once, so a single
    // shared mock value fails on the second page for the wrong reason.
    const f = vi.fn().mockImplementation(async () =>
      json({ results: [doc({ id: 'x' })], nextPageCursor: 'always' }));
    await listAll(opts(f as unknown as typeof fetch), {}, 3);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('tolerates a page with no results array', async () => {
    const f = vi.fn().mockResolvedValue(json({ nextPageCursor: null }));
    await expect(listAll(opts(f as unknown as typeof fetch), {})).resolves.toEqual([]);
  });
});

describe('fullText', () => {
  // THE documented-API contradiction. `content` is always null; the real text
  // is in `html_content`. Reading the wrong one yields an empty reader and no
  // error, which is precisely the silent failure this asserts against.
  it('reads html_content, not the documented content field', async () => {
    const f = vi.fn().mockResolvedValue(json({
      results: [{ ...doc({ id: '1' }), content: null, html_content: '<p>Real</p>' }],
      nextPageCursor: null,
    }));
    await expect(fullText(opts(f as unknown as typeof fetch), '1')).resolves.toBe('<p>Real</p>');
  });

  it('requests the article with withHtmlContent', async () => {
    const f = vi.fn().mockResolvedValue(json({
      results: [{ ...doc({ id: '1' }), html_content: '<p>x</p>' }], nextPageCursor: null,
    }));
    await fullText(opts(f as unknown as typeof fetch), '1');
    expect(f.mock.calls[0][0]).toContain('withHtmlContent=true');
    expect(f.mock.calls[0][0]).toContain('id=1');
  });

  it('raises a data error when there is no readable text', async () => {
    const f = vi.fn().mockResolvedValue(json({
      results: [{ ...doc({ id: '1' }), html_content: null }], nextPageCursor: null,
    }));
    await expect(fullText(opts(f as unknown as typeof fetch), '1'))
      .rejects.toMatchObject({ kind: 'data' });
  });

  it('raises a data error when the article is missing', async () => {
    const f = vi.fn().mockResolvedValue(json({ results: [], nextPageCursor: null }));
    await expect(fullText(opts(f as unknown as typeof fetch), 'gone'))
      .rejects.toMatchObject({ kind: 'data' });
  });
});

describe('writes', () => {
  it('archives via PATCH location=archive', async () => {
    const f = vi.fn().mockResolvedValue(json(doc({ id: '1', location: 'archive' })));
    await archive(opts(f as unknown as typeof fetch), '1');
    const [url, init] = f.mock.calls[0];
    expect(url).toContain('/update/1/');
    expect((init as RequestInit).method).toBe('PATCH');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ location: 'archive' });
  });

});

/**
 * The live API sends reading time as display text (verified 2026-09-24):
 * `"reading_time": "13 mins"`. Rendering it raw as `${t} min` printed
 * "13 mins min" on both surfaces.
 */
describe('readingMinutes', () => {
  it('reads the live string shape', () => {
    expect(readingMinutes({ reading_time: '13 mins' })).toBe(13);
    expect(readingMinutes({ reading_time: '1 min' })).toBe(1);
  });

  it('tolerates a number, as fixtures and old caches carry', () => {
    expect(readingMinutes({ reading_time: 7 })).toBe(7);
  });

  it('is null when Readwise could not estimate it', () => {
    expect(readingMinutes({ reading_time: null })).toBeNull();
    expect(readingMinutes({ reading_time: '' })).toBeNull();
    expect(readingMinutes({ reading_time: 'unknown' })).toBeNull();
    expect(readingMinutes({ reading_time: '0 mins' })).toBeNull();
  });
});
