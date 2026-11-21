/**
 * @vitest-environment happy-dom
 *
 * Needs a real `localStorage`: the mirror layer is half of what these tests
 * assert, and under the default `node` environment every `globalThis.localStorage?.`
 * call optional-chains to undefined, so the assertions would pass vacuously.
 *
 * Storage policy: what is written through, what is coalesced, what survives.
 *
 * These guard the bug that made the app forget everything on close — the
 * library cache and reading positions lived only in the webview, which the Even
 * Hub host clears. The debounce added for page turns is the risky part: it must
 * coalesce bursts WITHOUT ever leaving a position as the only copy in a buffer.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  debouncedKV, memoryKV, savePosition, loadPositions,
  K_PROGRESS, type KV,
} from './store';
import { withHost, localStorageOnly } from './storage';

function fakeHost(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: vi.fn(async (k: string) => data.get(k) ?? ''),
    set: vi.fn(async (k: string, v: string) => { data.set(k, v); return true; }),
  };
}

/** A manual clock, so the debounce is asserted rather than waited on. */
function manualSchedule() {
  const queued: Array<() => void> = [];
  return {
    schedule: (fn: () => void) => { queued.push(fn); return 0; },
    /** Fire everything currently queued. */
    tick: async () => {
      const due = queued.splice(0);
      for (const fn of due) fn();
      await Promise.resolve();
      await Promise.resolve();
    },
    get pending() { return queued.length; },
  };
}

describe('debouncedKV', () => {
  it('mirrors immediately, so a value is never only in the buffer', async () => {
    const slow = memoryKV();
    const fast = memoryKV();
    const clock = manualSchedule();
    const kv = debouncedKV(slow, fast, 2000, clock.schedule);

    await kv.set(K_PROGRESS, '{"a":1}');
    // Durable store has NOT been written yet...
    expect(await slow.get(K_PROGRESS)).toBeNull();
    // ...but the mirror has, so nothing is lost if the app dies right here.
    expect(await fast.get(K_PROGRESS)).toBe('{"a":1}');
  });

  it('coalesces a burst into a single durable write', async () => {
    const slow = memoryKV();
    const setSpy = vi.spyOn(slow, 'set');
    const clock = manualSchedule();
    const kv = debouncedKV(slow, memoryKV(), 2000, clock.schedule);

    // A reader swiping through several screens in a few seconds.
    for (const page of ['1', '2', '3', '4', '5']) {
      await kv.set(K_PROGRESS, page);
    }
    await clock.tick();

    // One bridge hop, not five — the whole point of the debounce.
    expect(setSpy).toHaveBeenCalledTimes(1);
    // And it carries the LATEST value, not the first.
    expect(await slow.get(K_PROGRESS)).toBe('5');
  });

  it('reads back a pending value from the mirror', async () => {
    const kv = debouncedKV(memoryKV(), memoryKV(), 2000, manualSchedule().schedule);
    await kv.set(K_PROGRESS, '{"a":3}');
    // Resume must work mid-session, before anything has been flushed.
    expect(await kv.get(K_PROGRESS)).toBe('{"a":3}');
  });

  it('prefers the durable copy once flushed', async () => {
    const slow = memoryKV();
    const fast = memoryKV();
    await slow.set(K_PROGRESS, 'durable');
    await fast.set(K_PROGRESS, 'stale-mirror');
    const kv = debouncedKV(slow, fast, 2000, manualSchedule().schedule);
    expect(await kv.get(K_PROGRESS)).toBe('durable');
  });

  it('flush() forces the write out without waiting for the timer', async () => {
    const slow = memoryKV();
    const clock = manualSchedule();
    const kv = debouncedKV(slow, memoryKV(), 2000, clock.schedule);

    await kv.set(K_PROGRESS, 'last-page');
    // This is what the exit path does: the app is going away, so the pending
    // position has to land NOW rather than 2s from now.
    await kv.flush();
    expect(await slow.get(K_PROGRESS)).toBe('last-page');
  });

  it('flush() is safe with nothing pending', async () => {
    const kv = debouncedKV(memoryKV(), memoryKV(), 2000, manualSchedule().schedule);
    await expect(kv.flush()).resolves.toBeUndefined();
  });

  it('survives a durable store that throws', async () => {
    const broken: KV = {
      get: async () => { throw new Error('bridge down'); },
      set: async () => { throw new Error('bridge down'); },
    };
    const fast = memoryKV();
    const clock = manualSchedule();
    const kv = debouncedKV(broken, fast, 2000, clock.schedule);

    await kv.set(K_PROGRESS, 'page');
    await clock.tick();
    // The durable write failed, but the mirror still answers — degraded, not
    // broken, which is the rule everywhere in this module.
    expect(await kv.get(K_PROGRESS)).toBe('page');
    await expect(kv.flush()).resolves.toBeUndefined();
  });
});

describe('withHost routing', () => {
  it('writes the library straight through to the host', async () => {
    const host = fakeHost();
    const { kv } = withHost(host);
    await kv.set('rw.library', '{"docs":[]}');
    // No debounce here: the library is written once per fetch and is what makes
    // the app boot to a cached list instead of a blank page.
    expect(host.data.get('rw.library')).toBe('{"docs":[]}');
  });

  it('writes summaries straight through', async () => {
    const host = fakeHost();
    const { kv } = withHost(host);
    // The most expensive thing to lose — a full Claude turn to regenerate.
    await kv.set('rw.summary.abc', 'a summary');
    expect(host.data.get('rw.summary.abc')).toBe('a summary');
  });

  it('defers reading positions', async () => {
    const host = fakeHost();
    const { kv, flush } = withHost(host, 2000);
    await kv.set(K_PROGRESS, '{"a":1}');
    // Not yet — this is the swipe path and must not pay a bridge hop.
    expect(host.data.has(K_PROGRESS)).toBe(false);
    await flush();
    expect(host.data.get(K_PROGRESS)).toBe('{"a":1}');
  });

  it('reads back everything it wrote, deferred or not', async () => {
    const { kv } = withHost(fakeHost());
    await kv.set('rw.library', 'lib');
    await kv.set(K_PROGRESS, 'pos');
    expect(await kv.get('rw.library')).toBe('lib');
    expect(await kv.get(K_PROGRESS)).toBe('pos');
  });

  it('migrates a cache left behind by an older build', async () => {
    // The previous build wrote the library to localStorage only. It must still
    // be readable, and get promoted into durable storage on the way past.
    const host = fakeHost();
    const local = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => local.get(key) ?? null,
      setItem: (key: string, value: string) => { local.set(key, value); },
      removeItem: (key: string) => { local.delete(key); },
    });
    try {
      globalThis.localStorage.setItem('rw.library', '{"docs":[],"fetchedAt":1}');
      const { kv } = withHost(host);
      expect(await kv.get('rw.library')).toBe('{"docs":[],"fetchedAt":1}');
      expect(host.data.get('rw.library')).toBe('{"docs":[],"fetchedAt":1}');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('positions through the real save path', () => {
  it('keeps every article across a debounced burst', async () => {
    // `savePosition` is read-modify-write over the WHOLE map, so a burst only
    // works if each deferred write is visible to the next read. It is, because
    // every set mirrors synchronously — if that ordering is ever broken, the
    // reader silently keeps only the last article's position.
    const host = fakeHost();
    const { kv, flush } = withHost(host, 2000);
    await savePosition(kv, 'a', 0.1);
    await savePosition(kv, 'b', 0.2);
    await savePosition(kv, 'c', 0.3);
    await flush();
    expect(await loadPositions(kv)).toEqual({ a: 0.1, b: 0.2, c: 0.3 });
    // And the durable copy is the complete one, not just the last write.
    expect(JSON.parse(host.data.get(K_PROGRESS)!)).toEqual({ a: 0.1, b: 0.2, c: 0.3 });
  });
});

describe('localStorageOnly', () => {
  it('has a flush that does nothing', async () => {
    // The phone runs on this until the bridge arrives, and in a plain browser
    // forever. `flush` exists so callers need no branch.
    await expect(localStorageOnly().flush()).resolves.toBeUndefined();
  });
});

describe('positions during slow host writes', () => {
  it('keeps the newest map readable throughout an in-flight flush', async () => {
    const data = memoryKV();
    await data.set(K_PROGRESS, '{"old":0.1}');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = { ...data, set: vi.fn(async (k: string, v: string) => {
      await gate;
      await data.set(k, v);
    }) };
    const kv = debouncedKV(slow, memoryKV(), 2000, manualSchedule().schedule);
    await savePosition(kv, 'a', 0.2);
    const firstFlush = kv.flush();
    await savePosition(kv, 'b', 0.3);
    expect(await loadPositions(kv)).toEqual({ old: 0.1, a: 0.2, b: 0.3 });
    const secondFlush = kv.flush();
    expect(slow.set).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([firstFlush, secondFlush]);
    expect(await loadPositions(data)).toEqual({ old: 0.1, a: 0.2, b: 0.3 });
    expect(slow.set).toHaveBeenCalledTimes(2);
  });

  it('ignores an old timer after a forced lifecycle flush', async () => {
    const queued: Array<() => void> = [];
    const slow = memoryKV();
    const write = vi.spyOn(slow, 'set');
    const kv = debouncedKV(slow, memoryKV(), 2000, (fn) => queued.push(fn));
    await kv.set('position', 'first');
    await kv.flush();
    await kv.set('position', 'second');
    queued[0](); // The first timer still fires after pagehide forced a flush.
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(1);
    queued[1]();
    await kv.flush();
    expect(await slow.get('position')).toBe('second');
  });

  it('prefers a swipe that happened while a durable read was waiting', async () => {
    let release!: (value: string) => void;
    const slow = { get: () => new Promise<string>((r) => { release = r; }), set: async () => {} };
    const kv = debouncedKV(slow, memoryKV(), 2000, manualSchedule().schedule);
    const reading = kv.get('position');
    await kv.set('position', 'new');
    release('old');
    expect(await reading).toBe('new');
  });
});
