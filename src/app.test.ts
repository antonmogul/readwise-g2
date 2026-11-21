import { describe, it, expect, vi } from 'vitest';
import {
  loadLibraryState, loadArticleText, summariseArticle, articlePreview, PREVIEW_CHARS, recordProgress,
  archiveArticle, archiveRemote, withoutDoc, restoreDoc, libraryStore, pruneArchived, wasFetched,
  archiveMarkers, singleFlight,
  rowsFor, syncedAt, loadDigest,
  LIBRARY_LOCATIONS, NO_TOKEN, withReadingProgress, type AppDeps,
} from './app';
import { memoryKV, loadLibrary, loadPositions, loadSummary, saveLibrary, saveSummary } from './readwise/store';
import type { Doc } from './readwise/client';

const doc = (over: Partial<Doc> & { id: string }): Doc => ({
  title: 'T', author: 'A', site_name: 'S', url: 'u', category: 'article',
  location: 'later', reading_progress: 0, reading_time: '5 mins',
  saved_at: '2026-08-06T10:00:00Z', summary: null, ...over,
});

const T0 = 1_700_000_000_000;

/** A fetch double that routes by URL: Readwise list/update, and the board ask. */
function fakeFetch(handlers: {
  list?: (url: string) => unknown;
  update?: () => unknown;
  ask?: () => unknown;
  failList?: boolean;
  failText?: boolean;
  failAsk?: boolean;
}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/ask')) {
      if (handlers.failAsk) throw new Error('no tailnet');
      return new Response(JSON.stringify(handlers.ask?.() ?? { reply: 'Brain gist.' }), { status: 200 });
    }
    if (u.includes('/update/')) {
      if (handlers.update) return new Response(JSON.stringify(handlers.update()), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (u.includes('withHtmlContent')) {
      if (handlers.failText) throw new Error('offline');
      return new Response(JSON.stringify({
        results: [{ ...doc({ id: '1' }), html_content: '<p>Article body here.</p>' }],
        nextPageCursor: null,
      }), { status: 200 });
    }
    if (handlers.failList) throw new Error('offline');
    return new Response(JSON.stringify(
      handlers.list?.(u) ?? { results: [doc({ id: '1' })], nextPageCursor: null },
    ), { status: 200 });
    void init;
  });
}

const deps = (over: Partial<AppDeps> & { fetchImpl: typeof fetch }): AppDeps => ({
  readwise: { token: 't', fetchImpl: over.fetchImpl },
  kv: memoryKV(),
  now: () => T0,
  boardBase: 'http://board',
  rand: () => 0,
  ...over,
});

describe('loadLibraryState', () => {
  it('fetches both locations and dedupes by id', async () => {
    // The same document returned under two queries must not become two rows.
    const f = fakeFetch({ list: () => ({ results: [doc({ id: 'shared' })], nextPageCursor: null }) });
    const d = deps({ fetchImpl: f as unknown as typeof fetch });
    const s = await loadLibraryState(d);
    expect(s.docs.map((x) => x.id)).toEqual(['shared']);
    expect(s.stale).toBe(false);
    expect(f.mock.calls.filter((c) => !String(c[0]).includes('/update/')).length)
      .toBeGreaterThanOrEqual(LIBRARY_LOCATIONS.length);
  });

  it('caches the library so a second load spends no requests', async () => {
    const f = fakeFetch({});
    const d = deps({ fetchImpl: f as unknown as typeof fetch });
    await loadLibraryState(d);
    const calls = f.mock.calls.length;
    const second = await loadLibraryState(d);
    expect(f.mock.calls.length).toBe(calls);
    expect(second.stale).toBe(false);
  });

  // THE offline acceptance check: killing the network must degrade to a
  // last-synced state, not a blank page.
  it('serves the stale cache when the network fails', async () => {
    const kv = memoryKV();
    await saveLibrary(kv, [doc({ id: 'cached' })], T0 - 60 * 60_000);
    const d = deps({ fetchImpl: fakeFetch({ failList: true }) as unknown as typeof fetch, kv });
    const s = await loadLibraryState(d);
    expect(s.docs.map((x) => x.id)).toEqual(['cached']);
    expect(s.stale).toBe(true);
    expect(s.error).toBeTruthy();
  });

  it('reports the error with no documents when there is no cache at all', async () => {
    const d = deps({ fetchImpl: fakeFetch({ failList: true }) as unknown as typeof fetch });
    const s = await loadLibraryState(d);
    expect(s.docs).toEqual([]);
    expect(s.error).toBeTruthy();
  });

  it('writes the fetched library to the cache', async () => {
    const kv = memoryKV();
    const d = deps({ fetchImpl: fakeFetch({}) as unknown as typeof fetch, kv });
    await loadLibraryState(d);
    expect((await loadLibrary(kv, T0))?.docs).toHaveLength(1);
  });

  // The user asked: skip the fresh cache. Still ONE bounded fetch, not a poll.
  it('refetches a fresh cache when forced', async () => {
    const f = fakeFetch({});
    const d = deps({ fetchImpl: f as unknown as typeof fetch });
    await loadLibraryState(d);
    const calls = f.mock.calls.length;
    const forced = await loadLibraryState(d, { force: true });
    expect(f.mock.calls.length).toBeGreaterThan(calls);
    expect(forced.stale).toBe(false);
  });

  // Sending an empty token got a 401 and greeted a new user with
  // "Offline · token rejected". First run is not an outage: send nothing.
  it('sends nothing and says so when there is no token', async () => {
    const f = fakeFetch({});
    const d = deps({ fetchImpl: f as unknown as typeof fetch, readwise: { token: '', fetchImpl: f as unknown as typeof fetch } });
    const s = await loadLibraryState(d);
    expect(f).not.toHaveBeenCalled();
    expect(s).toEqual({ docs: [], fetchedAt: 0, stale: true, error: NO_TOKEN });
  });

  it('still serves a cached library without a token, flagged', async () => {
    const kv = memoryKV();
    await saveLibrary(kv, [doc({ id: 'cached' })], T0 - 60_000);
    const f = fakeFetch({});
    const d = deps({ fetchImpl: f as unknown as typeof fetch, kv, readwise: { token: '', fetchImpl: f as unknown as typeof fetch } });
    const s = await loadLibraryState(d);
    expect(f).not.toHaveBeenCalled();
    expect(s.docs.map((x) => x.id)).toEqual(['cached']);
    expect(s.error).toBe(NO_TOKEN);
  });
});

describe('rowsFor', () => {
  it('applies the view selector to the loaded library', () => {
    const d = deps({ fetchImpl: fakeFetch({}) as unknown as typeof fetch });
    const state = {
      docs: [doc({ id: 'half', reading_progress: 0.5 }), doc({ id: 'new' })],
      fetchedAt: T0, stale: false, error: null,
    };
    expect(rowsFor(state, 'halfread', d).map((x) => x.id)).toEqual(['half']);
  });
});

/**
 * Opening an article never asks the Brain. Every summary used to be requested
 * on open, and each is a Claude session on the mini — one per row swiped
 * through (2026-11-19). The front page is a free preview; a summary is asked for.
 */
describe('opening an article', () => {
  it('fetches the text and does not ask the Brain', async () => {
    const f = fakeFetch({});
    const d = deps({ fetchImpl: f as unknown as typeof fetch });
    await loadArticleText(d, doc({ id: '1' }));
    expect(f.mock.calls.some((c) => String(c[0]).includes('/api/ask'))).toBe(false);
  });

  // Any resume policy agrees on this case: both sources say the same thing.
  it('resumes where you left the article', async () => {
    const kv = memoryKV();
    const d = deps({ fetchImpl: fakeFetch({}) as unknown as typeof fetch, kv });
    await recordProgress(d, '1', 0.4);
    expect((await loadArticleText(d, doc({ id: '1', reading_progress: 0.4 }))).resume).toBe(0.4);
  });

  it('opens a never-read article at the top', async () => {
    const d = deps({ fetchImpl: fakeFetch({}) as unknown as typeof fetch });
    expect((await loadArticleText(d, doc({ id: '1' }))).resume).toBe(0);
  });

  it('still hands back a cached summary when the text fetch fails', async () => {
    const kv = memoryKV();
    await saveSummary(kv, '1', 'Cached gist.');
    const d = deps({ fetchImpl: fakeFetch({ failText: true }) as unknown as typeof fetch, kv });
    const t = await loadArticleText(d, doc({ id: '1' }));
    expect(t.cachedSummary).toBe('Cached gist.');
    expect(t.error).toBeTruthy();
  });
});

describe('articlePreview', () => {
  // The blurb is in the library already, so it shows before the text arrives.
  it("prefers the publisher's blurb, labelled as the publisher's", () => {
    expect(articlePreview(doc({ id: '1', summary: '  A blurb.  ' }), 'Body.'))
      .toEqual({ text: 'A blurb.', source: 'publisher' });
  });

  it('falls back to the opening of the article', () => {
    expect(articlePreview(doc({ id: '1' }), 'First line. Second line.'))
      .toEqual({ text: 'First line. Second line.', source: 'opening' });
  });

  it('is capped — the reader is one press away', () => {
    const long = 'A sentence that goes on. '.repeat(100);
    expect(articlePreview(doc({ id: '1' }), long)!.text.length).toBeLessThanOrEqual(PREVIEW_CHARS + 1);
  });

  it('is null with nothing to show', () => {
    expect(articlePreview(doc({ id: '1', summary: '   ' }), '')).toBeNull();
  });
});

/**
 * The two halves the glasses load separately. The text is one request; an
 * uncached summary is a Claude turn — the reader must not wait for it.
 */
describe('loadArticleText', () => {
  it('returns the text without asking the Brain', async () => {
    const f = fakeFetch({});
    const d = deps({ fetchImpl: f as unknown as typeof fetch });
    const t = await loadArticleText(d, doc({ id: '1' }));
    expect(t.text).toBe('Article body here.');
    expect(t.cachedSummary).toBeNull();
    expect(f.mock.calls.some((c) => String(c[0]).includes('/api/ask'))).toBe(false);
  });

  it('hands back a cached summary so no model turn is needed', async () => {
    const kv = memoryKV();
    await saveSummary(kv, '1', 'Cached gist.');
    const d = deps({ fetchImpl: fakeFetch({}) as unknown as typeof fetch, kv });
    expect((await loadArticleText(d, doc({ id: '1' }))).cachedSummary).toBe('Cached gist.');
  });

  it('reports a failed fetch as an error, not a throw', async () => {
    const d = deps({ fetchImpl: fakeFetch({ failText: true }) as unknown as typeof fetch });
    const t = await loadArticleText(d, doc({ id: '1' }));
    expect(t.text).toBe('');
    expect(t.error).toBeTruthy();
  });
});

describe('summariseArticle', () => {
  it('caches a Brain summary', async () => {
    const kv = memoryKV();
    const d = deps({ fetchImpl: fakeFetch({}) as unknown as typeof fetch, kv });
    const s = await summariseArticle(d, doc({ id: '1' }), 'Article body here.');
    expect(s).toEqual({ text: 'Brain gist.', fromBrain: true });
    expect(await loadSummary(kv, '1')).toBe('Brain gist.');
  });

  it('does not cache an extract', async () => {
    const kv = memoryKV();
    const d = deps({ fetchImpl: fakeFetch({ failAsk: true }) as unknown as typeof fetch, kv });
    const s = await summariseArticle(d, doc({ id: '1' }), 'Article body here.');
    expect(s.fromBrain).toBe(false);
    expect(await loadSummary(kv, '1')).toBeNull();
  });
});

describe('recordProgress', () => {
  it('saves the position locally', async () => {
    const kv = memoryKV();
    const d = deps({ fetchImpl: fakeFetch({}) as unknown as typeof fetch, kv });
    await recordProgress(d, '1', 0.5);
    expect((await loadPositions(kv))['1']).toBe(0.5);
  });

  // Readwise answers a reading_progress PATCH with 200 and ignores it
  // (verified 2026-09-24). Sending it spent the update budget on nothing.
  it('sends nothing to Readwise — its progress is not writable', async () => {
    const f = fakeFetch({});
    const d = deps({ fetchImpl: f as unknown as typeof fetch });
    await recordProgress(d, '1', 0.3);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('archiveArticle', () => {
  const state = {
    docs: [doc({ id: 'a' }), doc({ id: 'b' })],
    fetchedAt: T0, stale: false, error: null,
  };

  it('removes the article and calls the API', async () => {
    const f = fakeFetch({});
    const d = deps({ fetchImpl: f as unknown as typeof fetch });
    const r = await archiveArticle(d, state, 'a');
    expect(r.state.docs.map((x) => x.id)).toEqual(['b']);
    expect(r.archived).toBe(true);
    expect(r.error).toBeNull();
    const patch = f.mock.calls.find((c) => String(c[0]).includes('/update/'));
    expect(JSON.parse((patch![1] as RequestInit).body as string))
      .toEqual({ location: 'archive' });
  });

  it('updates the cache so reopening does not resurrect the item', async () => {
    const kv = memoryKV();
    const d = deps({ fetchImpl: fakeFetch({}) as unknown as typeof fetch, kv });
    await archiveArticle(d, state, 'a');
    expect((await loadLibrary(kv, T0))?.docs.map((x) => x.id)).toEqual(['b']);
  });

  // A refresh can land while the PATCH is in flight. Filtering the library
  // captured before it would write that older snapshot back over the fresh
  // one — in memory and in the cache.
  it('applies to the library as it stands when Readwise answers, not the one captured', async () => {
    const kv = memoryKV();
    let live = state;
    const f = vi.fn(async (url: string) => {
      if (String(url).includes('/update/')) {
        // The refresh lands mid-flight: a new document arrived.
        live = { ...state, docs: [...state.docs, doc({ id: 'new' })], fetchedAt: T0 + 1 };
        return new Response(JSON.stringify({ id: 'a', location: 'archive' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    const d = deps({ fetchImpl: f as unknown as typeof fetch, kv });
    const r = await archiveArticle(d, () => live, 'a');
    expect(r.archived).toBe(true);
    expect(r.state.docs.map((x) => x.id)).toEqual(['b', 'new']);
    expect(r.state.fetchedAt).toBe(T0 + 1);
    expect((await loadLibrary(kv, T0 + 1))?.docs.map((x) => x.id)).toEqual(['b', 'new']);
  });
});

describe('libraryStore — the one place the library changes', () => {
  const lib = (ids: string[]) => ({ docs: ids.map((id) => doc({ id })), fetchedAt: T0, stale: false, error: null });

  // Two archives in flight at once (hold, hold): both read the same library,
  // each removed its own article, and the later write put the earlier one
  // back — in memory and in the cache.
  it('applies concurrent commits to the latest state, never a shared snapshot', async () => {
    let state: ReturnType<typeof lib> | null = lib(['a', 'b', 'c']);
    const persisted: string[][] = [];
    const store = libraryStore({
      read: () => state,
      write: (s) => { state = s; },
      // A slow cache write, so the second commit would otherwise read before it.
      persist: async (s) => { await new Promise((r) => setTimeout(r, 5)); persisted.push(s.docs.map((d) => d.id)); },
    });
    const a = store.commit((s) => withoutDoc(s!, 'a'));
    const b = store.commit((s) => withoutDoc(s!, 'b'));
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.docs.map((d) => d.id)).toEqual(['b', 'c']);
    expect(rb.docs.map((d) => d.id)).toEqual(['c']);
    expect(state!.docs.map((d) => d.id)).toEqual(['c']);
    expect(persisted).toEqual([['b', 'c'], ['c']]);
  });

  it('publishes the new state before the persist settles', async () => {
    let state: ReturnType<typeof lib> | null = lib(['a']);
    let release!: () => void;
    const store = libraryStore({
      read: () => state,
      write: (s) => { state = s; },
      persist: () => new Promise<void>((r) => { release = r; }),
    });
    const p = store.commit((s) => withoutDoc(s!, 'a'));
    await Promise.resolve(); await Promise.resolve();
    expect(state!.docs).toEqual([]);
    release();
    await p;
  });

  it('does not persist a commit that changed nothing, nor one marked as already cached', async () => {
    let state: ReturnType<typeof lib> | null = lib(['a']);
    const persist = vi.fn(async () => {});
    const store = libraryStore({ read: () => state, write: (s) => { state = s; }, persist });
    await store.commit((s) => withoutDoc(s!, 'gone'));
    await store.commit(() => lib(['z']), false);
    expect(persist).not.toHaveBeenCalled();
    expect(state!.docs.map((d) => d.id)).toEqual(['z']);
  });

  it('keeps serving commits after one throws', async () => {
    let state: ReturnType<typeof lib> | null = lib(['a']);
    const store = libraryStore({ read: () => state, write: (s) => { state = s; }, persist: async () => {} });
    await expect(store.commit(() => { throw new Error('boom'); })).rejects.toThrow('boom');
    await store.commit((s) => withoutDoc(s!, 'a'));
    expect(state!.docs).toEqual([]);
  });
});

describe('archiveRemote', () => {
  it('reports Readwise\'s answer and touches nothing local', async () => {
    const kv = memoryKV();
    const f = fakeFetch({});
    expect(await archiveRemote(deps({ fetchImpl: f as unknown as typeof fetch, kv }), 'a'))
      .toEqual({ archived: true, error: null });
    expect(await loadLibrary(kv, T0)).toBeNull();
    const redirected = fakeFetch({ update: () => doc({ id: 'a', location: 'later' }) });
    expect((await archiveRemote(deps({ fetchImpl: redirected as unknown as typeof fetch }), 'a')).archived).toBe(false);
  });
});

describe('restoreDoc — a failed archive puts the article back', () => {
  const lib = (ids: string[]) => ({ docs: ids.map((id) => doc({ id })), fetchedAt: T0, stale: false, error: null });

  it('is a no-op when the article is still there', () => {
    const s = lib(['a', 'b']);
    expect(restoreDoc(s, lib(['a', 'b']), 'a')).toBe(s);
  });

  // A refresh fetched while the PATCH was in flight may have been pruned of
  // the article; the snapshot still has it, in order.
  it('re-inserts the article from the snapshot at its place', () => {
    const s = restoreDoc(lib(['a', 'c', 'd']), lib(['a', 'b', 'c', 'd']), 'b');
    expect(s.docs.map((d) => d.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(restoreDoc(lib(['c']), lib(['b', 'c']), 'b').docs.map((d) => d.id)).toEqual(['b', 'c']);
  });

  it('leaves the library alone when no snapshot has the article', () => {
    const s = lib(['c']);
    expect(restoreDoc(s, null, 'b')).toBe(s);
    expect(restoreDoc(s, lib(['c']), 'b')).toBe(s);
  });
});

describe('archiveMarkers — stamped against the refresh clock', () => {
  it('forgets a marker only for a snapshot fetched after the confirmation that lacks the article', () => {
    const m = archiveMarkers();
    const early = m.tick();          // a refresh started before the archive
    m.confirm('b');
    m.settle(early, []);             // its snapshot cannot know about b
    expect(m.has('b')).toBe(true);
    const late = m.tick();           // a refresh started after
    m.settle(late, ['b']);           // snapshot still had b: Readwise lags, keep
    expect(m.has('b')).toBe(true);
    m.settle(m.tick(), []);          // a later snapshot without b: done with
    expect(m.has('b')).toBe(false);
  });

  it('lists the ids to prune', () => {
    const m = archiveMarkers();
    m.confirm('a'); m.confirm('b');
    expect(m.ids().sort()).toEqual(['a', 'b']);
  });
});

describe('singleFlight', () => {
  it('shares one in-flight call and starts a fresh one afterwards', async () => {
    let release!: (v: number) => void;
    const fn = vi.fn(() => new Promise<number>((r) => { release = r; }));
    const once = singleFlight(fn);
    const a = once();
    const b = once();
    expect(b).toBe(a);
    expect(fn).toHaveBeenCalledTimes(1);
    release(1);
    expect(await Promise.all([a, b])).toEqual([1, 1]);
    const c = once();
    expect(fn).toHaveBeenCalledTimes(2);
    release(2);
    expect(await c).toBe(2);
  });

  it('lets a rejected flight be retried', async () => {
    let n = 0;
    const once = singleFlight(async () => { if (++n === 1) throw new Error('first'); return n; });
    await expect(once()).rejects.toThrow('first');
    expect(await once()).toBe(2);
  });
});

/**
 * The round-4 race, end to end over the pure parts the shell composes: two
 * refresh requests overlap; without single flight the newer finished first,
 * its snapshot (fetched after the archive) lacked `b` and forgot the marker,
 * then the older snapshot — fetched before the archive, still holding `b` —
 * committed and brought it back. With single flight the second request joins
 * the first; and the marker stays until a snapshot that could know says so.
 */
describe('overlapping refreshes cannot resurrect an archived article', () => {
  const lib = (ids: string[]) => ({ docs: ids.map((id) => doc({ id })), fetchedAt: T0, stale: false, error: null });

  async function run(single: boolean) {
    let state: ReturnType<typeof lib> | null = lib(['a', 'b', 'c']);
    const store = libraryStore({ read: () => state, write: (s) => { state = s; }, persist: async () => {} });
    const markers = archiveMarkers();
    // Snapshot 1 is fetched BEFORE the archive (has b) but arrives LAST.
    const snapshots: Array<{ docs: string[]; delay: number }> = [
      { docs: ['a', 'b', 'c'], delay: 20 },
      { docs: ['a', 'c'], delay: 1 },
    ];
    const fetchLibrary = () => {
      const s = snapshots.shift()!;
      return new Promise<ReturnType<typeof lib>>((r) => setTimeout(() => r(lib(s.docs)), s.delay));
    };
    const refreshOnce = async () => {
      const startedAt = markers.tick();
      const fetched = await fetchLibrary();
      await store.commit(() => {
        const { state: next, pruned } = pruneArchived(fetched, markers.ids());
        markers.settle(startedAt, pruned);
        return next;
      }, false);
    };
    const refresh = single ? singleFlight(refreshOnce) : refreshOnce;
    const first = refresh();
    await store.commit((s) => { markers.confirm('b'); return withoutDoc(s!, 'b'); });
    const second = refresh();
    await Promise.all([first, second]);
    return { ids: state!.docs.map((d) => d.id), marked: markers.has('b') };
  }

  it('is the failure without single flight — the test would otherwise prove nothing', async () => {
    const r = await run(false);
    expect(r.ids).toContain('b');
  });

  it('holds with single flight: the article stays gone and its marker stays until a later snapshot', async () => {
    const r = await run(true);
    expect(r.ids).toEqual(['a', 'c']);
    expect(r.marked).toBe(true);
  });
});

describe('pruneArchived', () => {
  const fetched = {
    docs: [doc({ id: 'a' }), doc({ id: 'b' }), doc({ id: 'c' })],
    fetchedAt: T0, stale: false, error: null,
  };

  // A snapshot fetched before the archive's PATCH landed still holds the article.
  it('prunes archived ids from a snapshot and names what was pruned', () => {
    const r = pruneArchived(fetched, ['b']);
    expect(r.state.docs.map((x) => x.id)).toEqual(['a', 'c']);
    expect(r.pruned).toEqual(['b']);
  });

  it('returns the same state and nothing pruned when Readwise has already caught up', () => {
    const r = pruneArchived(fetched, ['gone']);
    expect(r.state).toBe(fetched);
    expect(r.pruned).toEqual([]);
  });

  it('only a fetched, non-stale library is worth re-caching', () => {
    expect(wasFetched(fetched)).toBe(true);
    expect(wasFetched({ ...fetched, stale: true })).toBe(false);
    expect(wasFetched({ ...fetched, fetchedAt: 0 })).toBe(false);
  });

  /**
   * The round-3 race: refresh snapshotted the confirmed set and persisted
   * off-chain; an archive confirmed during that persist was forgotten and the
   * published state still held the article. Filtering, bookkeeping and the
   * re-cache decision run inside ONE libraryStore commit that reads the set
   * at commit time — in either order, the article is gone and stays known.
   */
  it('inside one commit, never publishes an article confirmed archived meanwhile', async () => {
    for (const refreshFirst of [false, true]) {
      let state: typeof fetched | null = { ...fetched, docs: [doc({ id: 'a' }), doc({ id: 'c' })] };
      const archived = new Set<string>();
      const persisted: string[][] = [];
      const store = libraryStore({
        read: () => state,
        write: (s) => { state = s; },
        persist: async (s) => { await new Promise((r) => setTimeout(r, 5)); persisted.push(s.docs.map((d) => d.id)); },
      });
      const confirmB = () => store.commit((s) => { archived.add('b'); return withoutDoc(s!, 'b'); });
      let prunedAny = false;
      const refresh = () => store.commit(() => {
        const r = pruneArchived(fetched, archived);
        for (const id of archived) if (!r.pruned.includes(id)) archived.delete(id);
        prunedAny = r.pruned.length > 0;
        return r.state;
      }, (next) => prunedAny && wasFetched(next));
      await Promise.all(refreshFirst ? [refresh(), confirmB()] : [confirmB(), refresh()]);
      expect(state!.docs.map((d) => d.id)).toEqual(['a', 'c']);
      expect(archived.has('b')).toBe(true);
      // The archive's write, and — when the snapshot still had b — the refresh's.
      expect(persisted[persisted.length - 1]).toEqual(['a', 'c']);
    }
  });
});

describe('archiveArticle — when Readwise says no', () => {
  const state = {
    docs: [doc({ id: 'a' }), doc({ id: 'b' })],
    fetchedAt: T0, stale: false, error: null,
  };

  it('does not claim success when Readwise reports another location', async () => {
    const f = fakeFetch({ update: () => doc({ id: 'a', location: 'later' }) });
    const r = await archiveArticle(
      deps({ fetchImpl: f as unknown as typeof fetch }), state, 'a',
    );
    expect(r.archived).toBe(false);
    expect(r.state.docs.map((x) => x.id)).toEqual(['a', 'b']);
    expect(r.error).toContain('did not move');
  });

  it('keeps the article and cache when the Readwise write fails', async () => {
    const kv = memoryKV();
    await saveLibrary(kv, state.docs, T0);
    const f = vi.fn(async (url: string) => {
      if (String(url).includes('/update/')) throw new Error('offline');
      return new Response('{}', { status: 200 });
    });
    const d = deps({ fetchImpl: f as unknown as typeof fetch, kv });
    const r = await archiveArticle(d, state, 'a');
    expect(r.archived).toBe(false);
    expect(r.state.docs.map((x) => x.id)).toEqual(['a', 'b']);
    expect((await loadLibrary(kv, T0))?.docs.map((x) => x.id)).toEqual(['a', 'b']);
    expect(r.error).toBeTruthy();
  });
});

describe('syncedAt', () => {
  it('formats a clock time for the offline banner', () => {
    expect(syncedAt(new Date('2026-08-06T18:05:00').getTime())).toBe('18:05');
  });

  it('is null when nothing was ever synced', () => {
    expect(syncedAt(0)).toBeNull();
  });
});

describe('loadDigest', () => {
  const feedDoc = (id: string, site: string) => ({
    ...doc({ id, site_name: site, location: 'feed' as const }),
    saved_at: new Date(T0 - 3_600_000).toISOString(),
  });

  /** A fetch double for the digest: feed list + a triage reply from the board. */
  const digestFetch = (opts: {
    docs?: Doc[]; askReply?: string; failAsk?: boolean; failList?: boolean;
  } = {}) => vi.fn(async (url: string, _init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/ask')) {
      if (opts.failAsk) throw new Error('no tailnet');
      return new Response(JSON.stringify({
        reply: opts.askReply ?? '{"sections":[{"name":"AI","ids":["1"],"note":"why"}]}',
      }), { status: 200 });
    }
    if (opts.failList) throw new Error('offline');
    return new Response(JSON.stringify({
      results: opts.docs ?? [feedDoc('1', 'Wired'), feedDoc('2', 'Wired')],
      nextPageCursor: null,
    }), { status: 200 });
  });

  it('returns the Brain triage when the board answers', async () => {
    const f = digestFetch();
    const d = await loadDigest(deps({ fetchImpl: f as unknown as typeof fetch }));
    expect(d.fromBrain).toBe(true);
    expect(d.sections[0].name).toBe('AI');
    expect(d.sections[0].note).toBe('why');
  });

  it('fetches Feed without category=article so RSS and newsletters are included', async () => {
    const rss = feedDoc('1', 'Wired');
    rss.category = 'rss';
    const f = digestFetch({ docs: [rss] });
    const d = await loadDigest(deps({ fetchImpl: f as unknown as typeof fetch }));
    const listCall = f.mock.calls.find(([u]) => !String(u).includes('/api/ask'));
    const listUrl = String(listCall![0]);
    expect(listUrl).toContain('location=feed');
    expect(listUrl).not.toContain('category=article');
    expect(d.sections.flatMap((s) => s.docs).map((x) => x.id)).toContain('1');
  });

  it('drops video and PDF Feed entries before optional Brain triage', async () => {
    const rss = feedDoc('rss', 'Wired');
    rss.category = 'rss';
    const video = feedDoc('video', 'YouTube');
    video.category = 'video';
    const f = digestFetch({ docs: [rss, video] });
    await loadDigest(deps({ fetchImpl: f as unknown as typeof fetch }));
    const askCall = f.mock.calls.find(([u]) => String(u).includes('/api/ask'));
    expect(String(askCall?.[1]?.body)).toContain('rss');
    expect(String(askCall?.[1]?.body)).not.toContain('video');
  });

  it('falls back to grouping when the board is unreachable', async () => {
    // The digest is the daily surface. It must not go down with the tailnet.
    const f = digestFetch({ failAsk: true });
    const d = await loadDigest(deps({ fetchImpl: f as unknown as typeof fetch }));
    expect(d.fromBrain).toBe(false);
    expect(d.sections[0].name).toBe('Wired');
    expect(d.sections[0].docs).toHaveLength(2);
  });

  it('falls back to grouping when the model writes nonsense', async () => {
    const f = digestFetch({ askReply: 'I would read all of them, honestly.' });
    const d = await loadDigest(deps({ fetchImpl: f as unknown as typeof fetch }));
    expect(d.fromBrain).toBe(false);
    expect(d.sections.length).toBeGreaterThan(0);
  });

  it('reuses a cached triage instead of paying for another turn', async () => {
    const kv = memoryKV();
    const f1 = digestFetch();
    await loadDigest(deps({ fetchImpl: f1 as unknown as typeof fetch, kv }));
    const f2 = digestFetch();
    const d = await loadDigest(deps({ fetchImpl: f2 as unknown as typeof fetch, kv }));
    expect(d.fromBrain).toBe(true);
    // The feed is re-fetched (it changes); the board is NOT re-asked.
    expect(f2.mock.calls.filter(([u]) => String(u).includes('/api/ask'))).toHaveLength(0);
  });

  it('forces fresh triage after an explicit Feed mutation', async () => {
    const kv = memoryKV();
    await loadDigest(deps({ fetchImpl: digestFetch() as unknown as typeof fetch, kv }));
    const f = digestFetch({
      askReply: '{"sections":[{"name":"Fresh","ids":["2"],"note":"after archive"}]}',
    });
    const d = await loadDigest(
      deps({ fetchImpl: f as unknown as typeof fetch, kv }),
      { forceTriage: true },
    );
    expect(d.sections[0].name).toBe('Fresh');
    expect(f.mock.calls.filter(([u]) => String(u).includes('/api/ask'))).toHaveLength(1);
  });

  it('excludes the archived ID from a refreshed Feed even if indexing lags', async () => {
    const f = digestFetch({
      askReply: '{"sections":[{"name":"Fresh","ids":["1","2"]}]}',
    });
    const d = await loadDigest(
      deps({ fetchImpl: f as unknown as typeof fetch }),
      { forceTriage: true, excludeIds: ['1'] },
    );
    expect(d.sections.flatMap((section) => section.docs).map((doc) => doc.id))
      .toEqual(['2']);
    const ask = f.mock.calls.find(([url]) => String(url).includes('/api/ask'));
    expect(String(ask?.[1]?.body)).not.toContain('\t1\t');
  });

  it('prefers a stale cached triage over plain grouping', async () => {
    const kv = memoryKV();
    await loadDigest(deps({ fetchImpl: digestFetch() as unknown as typeof fetch, kv }));
    // Much later, and the board is now down: yesterday's picks still name real
    // articles, which beats falling back to publication buckets.
    const f = digestFetch({ failAsk: true });
    const d = await loadDigest(deps({
      fetchImpl: f as unknown as typeof fetch, kv, now: () => T0 + 86_400_000,
    }));
    expect(d.fromBrain).toBe(true);
    expect(d.sections[0].name).toBe('AI');
  });

  it('reports the error and stays empty when the feed cannot be fetched', async () => {
    const f = digestFetch({ failList: true });
    const d = await loadDigest(deps({ fetchImpl: f as unknown as typeof fetch }));
    expect(d.sections).toEqual([]);
    expect(d.error).toBeTruthy();
  });

  it('does not ask the board about an empty feed', async () => {
    const f = digestFetch({ docs: [] });
    const d = await loadDigest(deps({ fetchImpl: f as unknown as typeof fetch }));
    expect(d.sections).toEqual([]);
    expect(f.mock.calls.filter(([u]) => String(u).includes('/api/ask'))).toHaveLength(0);
  });

  it('never throws — every failure is a smaller true thing', async () => {
    const f = vi.fn(async () => { throw new Error('everything is down'); });
    await expect(loadDigest(deps({ fetchImpl: f as unknown as typeof fetch })))
      .resolves.toMatchObject({ sections: [], fromBrain: false });
  });
});


describe('Continue uses reading done on this device', () => {
  for (const source of ['network', 'fresh cache', 'offline cache'] as const) {
    it(`includes local reading from ${source} without writing to Readwise`, async () => {
      const kv = memoryKV();
      const docs = [doc({ id: 'started' }), doc({ id: 'finished', reading_progress: 0.5 }),
        doc({ id: 'remote', reading_progress: 0.3 })];
      const f = fakeFetch({ failList: source === 'offline cache', list: () => ({ results: docs, nextPageCursor: null }) });
      const d = deps({ kv, fetchImpl: f as unknown as typeof fetch });
      if (source !== 'network') await saveLibrary(kv, docs, source === 'fresh cache' ? T0 : T0 - 3_600_000);
      await recordProgress(d, 'started', 0.4);
      await recordProgress(d, 'finished', 1);
      const state = await loadLibraryState(d);
      expect(rowsFor(state, 'halfread', d).map((x) => x.id)).toEqual(['started', 'remote']);
      expect(state.docs.find((x) => x.id === 'finished')?.reading_progress).toBe(1);
      expect(f.mock.calls.some((c) => String(c[0]).includes('/update/'))).toBe(false);
      if (source === 'fresh cache') expect(f).not.toHaveBeenCalled();
    });
  }

  it('ignores corrupt progress and leaves the source records intact', () => {
    const docs = [doc({ id: 'a', reading_progress: 0.2 }), doc({ id: 'b', reading_progress: 0.3 })];
    expect(withReadingProgress(docs, { a: NaN, b: 5 })).toEqual(docs);
    expect(withReadingProgress(docs, { a: 0 })[0].reading_progress).toBe(0);
    expect(docs[0].reading_progress).toBe(0.2);
  });
});
