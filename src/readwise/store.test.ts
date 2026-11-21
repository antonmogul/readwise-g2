import { describe, it, expect, vi } from 'vitest';
import {
  memoryKV, saveLibrary, loadLibrary, loadPositions, savePosition,
  loadSummary, saveSummary,
  LIBRARY_TTL_MS, MAX_POSITIONS, K_PROGRESS, type KV,
} from './store';
import type { Doc } from './client';

const doc = (id: string): Doc => ({
  id, title: `T${id}`, author: null, site_name: null, url: 'u',
  category: 'article', location: 'later', reading_progress: 0,
  reading_time: null, saved_at: '2026-08-06T10:00:00Z', summary: null,
});

const T0 = 1_000_000;

describe('library cache', () => {
  it('round-trips the library', async () => {
    const kv = memoryKV();
    await saveLibrary(kv, [doc('1'), doc('2')], T0);
    const got = await loadLibrary(kv, T0);
    expect(got?.docs.map((d) => d.id)).toEqual(['1', '2']);
    expect(got?.fresh).toBe(true);
  });

  it('reports a cache older than the TTL as stale', async () => {
    const kv = memoryKV();
    await saveLibrary(kv, [doc('1')], T0);
    expect((await loadLibrary(kv, T0 + LIBRARY_TTL_MS + 1))?.fresh).toBe(false);
  });

  // THE offline contract: stale data is still SERVED, flagged as stale. If this
  // returned null the app would show a blank page with the tailnet down, which
  // is the exact failure the acceptance check tests for.
  it('still returns the documents when stale', async () => {
    const kv = memoryKV();
    await saveLibrary(kv, [doc('1')], T0);
    const got = await loadLibrary(kv, T0 + LIBRARY_TTL_MS * 10);
    expect(got?.docs).toHaveLength(1);
  });

  it('returns null when nothing was ever cached', async () => {
    expect(await loadLibrary(memoryKV(), T0)).toBeNull();
  });

  it('treats a corrupt cache as no cache rather than throwing', async () => {
    const kv = memoryKV();
    await kv.set('rw.library', '{ not json');
    expect(await loadLibrary(kv, T0)).toBeNull();
  });

  it('rejects a cache whose shape is wrong', async () => {
    const kv = memoryKV();
    await kv.set('rw.library', JSON.stringify({ docs: 'nope', fetchedAt: T0 }));
    expect(await loadLibrary(kv, T0)).toBeNull();
  });
});

describe('reading positions', () => {
  it('remembers how far through an article you were', async () => {
    const kv = memoryKV();
    await savePosition(kv, 'a', 0.42);
    expect((await loadPositions(kv)).a).toBe(0.42);
  });

  it('updates an existing position', async () => {
    const kv = memoryKV();
    await savePosition(kv, 'a', 0.3);
    await savePosition(kv, 'a', 0.9);
    const p = await loadPositions(kv);
    expect(p.a).toBe(0.9);
    expect(Object.keys(p)).toHaveLength(1);
  });

  it('stores a fraction, never a value outside 0..1', async () => {
    const kv = memoryKV();
    await savePosition(kv, 'a', 12);
    await savePosition(kv, 'b', -1);
    expect(await loadPositions(kv)).toEqual({ a: 1, b: 0 });
  });

  // The old key held seven-line page numbers. Reading them as fractions would
  // reopen an article at "page 12" = 100%, so the format moved to a new key.
  it('does not read the old page-number positions', async () => {
    const kv = memoryKV();
    await kv.set('rw.progress', '{"a":12}');
    expect(await loadPositions(kv)).toEqual({});
    expect(K_PROGRESS).not.toBe('rw.progress');
  });

  it('returns an empty record when nothing is stored', async () => {
    expect(await loadPositions(memoryKV())).toEqual({});
  });

  it('survives corrupt data', async () => {
    const kv = memoryKV();
    await kv.set(K_PROGRESS, 'garbage');
    expect(await loadPositions(kv)).toEqual({});
  });

  // Storage on the glasses is not free, and a position for an article read a
  // year ago has no value.
  it('keeps only the most recent positions', async () => {
    const kv = memoryKV();
    for (let i = 0; i < MAX_POSITIONS + 20; i++) await savePosition(kv, `a${i}`, 0.5);
    const p = await loadPositions(kv);
    expect(Object.keys(p)).toHaveLength(MAX_POSITIONS);
    // The newest survive; the oldest are evicted.
    expect(p[`a${MAX_POSITIONS + 19}`]).toBe(0.5);
    expect(p.a0).toBeUndefined();
  });

  it('moves a re-read article to the recent end so it is not evicted', async () => {
    const kv = memoryKV();
    await savePosition(kv, 'old', 0.1);
    for (let i = 0; i < MAX_POSITIONS - 1; i++) await savePosition(kv, `f${i}`, 0.5);
    await savePosition(kv, 'old', 0.2);
    await savePosition(kv, 'newest', 0);
    expect((await loadPositions(kv)).old).toBe(0.2);
  });
});

describe('summary cache', () => {
  // A summary costs a full Claude turn on the mini — the most expensive
  // redundant call in the app. Articles do not change, so neither do summaries.
  it('round-trips a summary with no expiry', async () => {
    const kv = memoryKV();
    await saveSummary(kv, 'a', 'The gist.');
    expect(await loadSummary(kv, 'a')).toBe('The gist.');
  });

  it('returns null for an article never summarised', async () => {
    expect(await loadSummary(memoryKV(), 'nope')).toBeNull();
  });
});

describe('KV failure tolerance', () => {
  // localStorage throws in private mode and past quota. These paths run
  // precisely when things are already going wrong, so a failing cache must
  // degrade to "no cache" — never take down a render that would otherwise work.
  const hostile = (): KV => ({
    get: vi.fn().mockRejectedValue(new Error('storage gone')),
    set: vi.fn().mockRejectedValue(new Error('quota exceeded')),
  });

  it('reads degrade to empty instead of throwing', async () => {
    await expect(loadLibrary(hostile(), T0)).resolves.toBeNull();
    await expect(loadPositions(hostile())).resolves.toEqual({});
    await expect(loadSummary(hostile(), 'a')).resolves.toBeNull();
  });

  it('writes swallow storage failures', async () => {
    await expect(saveLibrary(hostile(), [doc('1')], T0)).resolves.toBeUndefined();
    await expect(saveSummary(hostile(), 'a', 'gist')).resolves.toBeUndefined();
    await expect(savePosition(hostile(), 'a', 0.3)).resolves.toBeDefined();
  });
});
