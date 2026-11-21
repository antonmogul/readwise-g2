/**
 * Persistence: the last-synced library, cached summaries, and where you were.
 *
 * Three jobs, all of which exist because of a constraint stated in the card:
 *
 *   1. OFFLINE. Killing the tailnet must degrade to a last-synced state, not a
 *      blank page. That is an explicit acceptance check, so the library is
 *      written to storage on every successful fetch and read back on failure.
 *   2. RATE LIMIT. 20 requests/minute. A cached list with a TTL is what makes
 *      "fetch lists once per session, never poll" actually true.
 *   3. RESUME. Reopening an article returns to where you left it.
 *
 * Storage is injected as a plain key/value interface rather than assuming the
 * SDK's store or `localStorage`: the glasses, the phone webview and the tests
 * each provide a different one, and this module should not know which.
 */

import type { Doc } from './client';

export type KV = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
};

/** In-memory KV. The test double, and the fallback when no store exists. */
export function memoryKV(): KV {
  const m = new Map<string, string>();
  return {
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => { m.set(k, v); },
  };
}

/**
 * `localStorage`-backed KV for the phone webview.
 *
 * Wrapped in try/catch because storage throws in private mode and when the
 * quota is exceeded — and a failure to CACHE must never break a page that
 * would otherwise render fine from the network.
 */
export function localKV(): KV {
  return {
    get: async (k) => {
      try { return globalThis.localStorage?.getItem(k) ?? null; } catch { return null; }
    },
    set: async (k, v) => {
      try { globalThis.localStorage?.setItem(k, v); } catch { /* cache is best-effort */ }
    },
  };
}

/**
 * The two host-storage calls this module needs, as plain functions.
 *
 * Deliberately NOT the bridge object: taking the methods keeps this file free
 * of any SDK import, so it stays pure and testable. `main.ts` — the only file
 * allowed to touch the SDK — passes `bridge.getLocalStorage` / `setLocalStorage`
 * in. A fake pair is all a test needs.
 */
export type HostStore = {
  get(key: string): Promise<string>;
  set(key: string, value: string): Promise<boolean>;
};

/**
 * Host-backed KV — the DURABLE one.
 *
 * The webview's own `localStorage` does not survive the Even Hub app closing:
 * a token written there is gone by the next launch, which is what made the app
 * ask for it on every open. `bridge.setLocalStorage` persists through the host
 * app instead, and is the only storage here that actually outlives a session.
 *
 * Reads normalise the host's empty string to `null` so callers can treat "not
 * set" the same way they do for every other KV. Writes swallow failure, like
 * every write in this module: a cache that cannot be written must not break a
 * render that would otherwise succeed.
 */
export function hostKV(host: HostStore): KV {
  return {
    get: async (k) => {
      try { return (await host.get(k)) || null; } catch { return null; }
    },
    set: async (k, v) => {
      try { await host.set(k, v); } catch { /* durable write is best-effort */ }
    },
  };
}

/**
 * Read through `primary`, falling back to `backup`, and write to BOTH.
 *
 * Used to pair the durable host store with `localStorage`: the host store is
 * the source of truth across launches, while the mirror keeps a value readable
 * synchronously within the session (and keeps the phone working in a plain
 * browser, where there is no bridge at all).
 *
 * A missing value in `primary` is backfilled from `backup` on read, which is
 * what migrates a token saved by an older build — the user does not have to
 * paste it again.
 */
export function layeredKV(primary: KV, backup: KV): KV {
  return {
    get: async (k) => {
      const hit = await primary.get(k).catch(() => null);
      if (hit !== null) return hit;
      const fallback = await backup.get(k).catch(() => null);
      // Backfill so the next launch finds it in the durable store directly.
      if (fallback !== null) await primary.set(k, fallback).catch(() => {});
      return fallback;
    },
    set: async (k, v) => {
      await Promise.all([
        primary.set(k, v).catch(() => {}),
        backup.set(k, v).catch(() => {}),
      ]);
    },
  };
}

/** A KV whose deferred writes can be forced out early. */
export type FlushableKV = KV & {
  /** Write any pending values now. Await before the app can be torn down. */
  flush(): Promise<void>;
};

/**
 * Default quiet period before a deferred write reaches durable storage.
 *
 * Page turns arrive in bursts — a reader swipes several screens in a few
 * seconds — and each one rewrites the whole positions map. 2s is long enough
 * that a burst costs ONE durable write instead of one per swipe, short enough
 * that pausing to read leaves the position saved almost immediately.
 */
export const FLUSH_DELAY_MS = 2000;

/**
 * Defer writes to `slow`, mirroring them to `fast` immediately.
 *
 * WHY. `savePosition` runs on EVERY page turn, and on the glasses the durable
 * store is a bridge hop that queues behind renders — paying it per swipe makes
 * paging feel laggy. So the mirror (`localStorage`, synchronous and cheap) is
 * written at once and the durable write is coalesced.
 *
 * Reads prefer the latest session write, including during a flush. Before
 * anything has been written this session, they use the durable copy and fall
 * back to the mirror. This preserves progress through slow bridge responses.
 *
 * The worst case is losing the last few seconds of durable writes if the app is
 * killed mid-burst: the position is then a page or two behind, never absent.
 * `flush()` exists so a caller that KNOWS it is going away can avoid even that.
 */
export function debouncedKV(
  slow: KV,
  fast: KV,
  delayMs = FLUSH_DELAY_MS,
  schedule: (fn: () => void, ms: number) => unknown = setTimeout,
): FlushableKV {
  // Keep session writes visible while a host write or read is in flight. The
  // durable copy can lag by an entire sheet while BLE is busy rendering.
  const pending = new Map<string, { value: string }>();
  const latest = new Map<string, { value: string }>();
  let timer: object | null = null;
  let inFlight: Promise<void> | null = null;

  const writeOut = (): Promise<void> => {
    // Invalidate a scheduled callback without depending on a browser timer ID
    // (the host SDK supplies its own timers).
    timer = null;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      while (pending.size > 0) {
        const batch = [...pending];
        pending.clear();
        // One host write at a time, including across overlapping flush calls.
        for (const [key, entry] of batch) {
          await slow.set(key, entry.value).catch(() => {});
          // Retain the session copy: even a slow read started before this
          // write may still resolve with the previous durable value.
        }
      }
    })().finally(() => {
      inFlight = null;
      // A write can arrive between the drain completing and this microtask.
      if (pending.size > 0) return writeOut();
    });
    return inFlight;
  };

  return {
    get: async (k) => {
      const queued = latest.get(k);
      if (queued) return queued.value;
      const hit = await slow.get(k).catch(() => null);
      // A swipe may have written a newer value while that bridge read waited.
      const newer = latest.get(k);
      if (newer) return newer.value;
      if (hit !== null) return hit;
      return fast.get(k).catch(() => null);
    },
    set: async (k, v) => {
      const entry = { value: v };
      pending.set(k, entry);
      latest.set(k, entry);
      // Invoke the mirror immediately; localKV writes synchronously.
      const mirrored = fast.set(k, v).catch(() => {});
      if (timer === null && !inFlight) {
        const ticket = {};
        timer = ticket;
        schedule(() => {
          if (timer === ticket) void writeOut();
        }, delayMs);
      }
      await mirrored;
    },
    flush: writeOut,
  };
}

const K_LIBRARY = 'rw.library';
/**
 * Exported so storage policy can route this key's writes — see `storage.ts`.
 *
 * `.v2` because the values changed meaning. `rw.progress` held seven-line
 * page numbers from the pre-sheet reader; read as positions now, page 12 of a
 * long article would reopen it near its end. Those entries are left behind
 * rather than misread. (They were never mirrored to Readwise either: its
 * `reading_progress` is not writable through the API.)
 */
export const K_PROGRESS = 'rw.progress.v2';
const K_SUMMARY = 'rw.summary.';
const K_DIGEST = 'rw.digest';

/**
 * How long a cached library is served without refetching.
 *
 * 15 minutes is a deliberate compromise: long enough that opening the app
 * repeatedly (the actual usage pattern — glance, close, glance) costs nothing
 * against the 20/min budget, short enough that something saved on the phone
 * this morning appears on the glasses this afternoon.
 */
export const LIBRARY_TTL_MS = 15 * 60_000;

export type CachedLibrary = {
  docs: Doc[];
  /** Epoch ms of the fetch that produced this. */
  fetchedAt: number;
};

export async function saveLibrary(kv: KV, docs: Doc[], now: number): Promise<void> {
  // Best-effort, like every write here: failing to CACHE data we already hold
  // in memory must not fail the render that data was fetched for.
  await kv.set(K_LIBRARY, JSON.stringify({ docs, fetchedAt: now } satisfies CachedLibrary))
    .catch(() => {});
}

/**
 * Read the cached library.
 *
 * Returns the payload EVEN IF STALE, with `fresh` saying which it is. That
 * split is the whole offline story: the caller serves stale data with a
 * "last synced" note rather than showing nothing, and only refetches when
 * it can. Returning null for stale data would reintroduce the blank page.
 */
export async function loadLibrary(
  kv: KV,
  now: number,
  ttl = LIBRARY_TTL_MS,
): Promise<{ docs: Doc[]; fetchedAt: number; fresh: boolean } | null> {
  // The KV itself can throw — localStorage does in private mode and past quota.
  // A cache read failing must degrade to "no cache", never propagate: this path
  // runs precisely when things are already going wrong.
  const raw = await kv.get(K_LIBRARY).catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CachedLibrary;
    if (!Array.isArray(parsed.docs)) return null;
    return {
      docs: parsed.docs,
      fetchedAt: parsed.fetchedAt,
      fresh: now - parsed.fetchedAt < ttl,
    };
  } catch {
    // Corrupt cache is equivalent to no cache. Never throw out of a read path.
    return null;
  }
}

// ------------------------------------------------------------ reading position

export type Positions = Record<string, number>;

/**
 * Where you left each article, as a fraction of its text (0..1).
 *
 * A fraction rather than a page or sheet index: an index means something only
 * at one layout, and the layout has changed under stored positions once
 * already. A fraction survives a new sheet budget, a new title, a new font.
 */
export async function loadPositions(kv: KV): Promise<Positions> {
  const raw = await kv.get(K_PROGRESS).catch(() => null);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Positions;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Remember the position. Bounded to the 200 most recent articles so a library
 * of thousands cannot grow this record without limit — storage on the glasses
 * is not free, and a position for an article read a year ago has no value.
 */
export const MAX_POSITIONS = 200;

export async function savePosition(
  kv: KV,
  id: string,
  progress: number,
): Promise<Positions> {
  const positions = await loadPositions(kv);
  // Delete before set so re-reading an article moves it to the most-recent end
  // of insertion order, which is what the trim below relies on.
  delete positions[id];
  positions[id] = Math.min(1, Math.max(0, progress));
  const keys = Object.keys(positions);
  const trimmed: Positions = {};
  for (const k of keys.slice(Math.max(0, keys.length - MAX_POSITIONS))) {
    trimmed[k] = positions[k];
  }
  await kv.set(K_PROGRESS, JSON.stringify(trimmed)).catch(() => {});
  return trimmed;
}

// ------------------------------------------------------------------ summaries

/**
 * Summaries are cached forever, keyed by article.
 *
 * No TTL: an article does not change, so its summary does not either. This
 * matters more than the library cache — a summary costs a full Claude turn on
 * the mini, so regenerating one the user has already seen is the most
 * expensive redundant call in the app.
 */
export async function loadSummary(kv: KV, id: string): Promise<string | null> {
  return kv.get(K_SUMMARY + id).catch(() => null);
}

export async function saveSummary(kv: KV, id: string, text: string): Promise<void> {
  await kv.set(K_SUMMARY + id, text).catch(() => {});
}

// ------------------------------------------------------------------ digest

/**
 * How long a triaged digest is served before it is rebuilt.
 *
 * Longer than the library's 15 minutes, and for a different reason: the digest
 * costs a full Claude turn over a hundred titles, which is the most expensive
 * call in the app. Three hours means opening it repeatedly through a morning is
 * free, while an afternoon look still reflects what arrived since.
 */
export const DIGEST_TTL_MS = 3 * 60 * 60_000;

export type CachedDigest = {
  /** Section names, notes, and the doc IDs under them. */
  picks: Array<{ name: string; ids: string[]; note?: string | null }>;
  builtAt: number;
};

export async function saveDigest(
  kv: KV,
  picks: CachedDigest['picks'],
  now: number,
): Promise<void> {
  await kv.set(K_DIGEST, JSON.stringify({ picks, builtAt: now } satisfies CachedDigest))
    .catch(() => {});
}

/**
 * Read the cached triage.
 *
 * Returns it even when stale, with `fresh` saying which — the same split as the
 * library. A stale digest still names real articles, and showing yesterday's
 * picks beats showing nothing while the board is unreachable. IDs are resolved
 * against the live feed by `applyTriage`, so an item that has gone simply drops.
 */
export async function loadDigest(
  kv: KV,
  now: number,
  ttl = DIGEST_TTL_MS,
): Promise<{ picks: CachedDigest['picks']; builtAt: number; fresh: boolean } | null> {
  const raw = await kv.get(K_DIGEST).catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CachedDigest;
    if (!Array.isArray(parsed.picks)) return null;
    return { picks: parsed.picks, builtAt: parsed.builtAt, fresh: now - parsed.builtAt < ttl };
  } catch {
    return null;
  }
}

