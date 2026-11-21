/**
 * The app's storage, assembled.
 *
 * WHY THIS FILE EXISTS. The webview's `localStorage` does not survive the Even
 * Hub app closing, so everything kept only there was gone by the next launch:
 * the token (the app asked for it every time), the library cache (the offline
 * story — "backend killed → boots to the cached library" — could not actually
 * hold), and reading positions (resume forgot where you were).
 *
 * The durable store is the host's, reached through the bridge. But the three
 * kinds of data have different write profiles, and one policy does not fit all:
 *
 *   LIBRARY   written once per fetch, at most every 15 minutes. Large, and the
 *             thing standing between the user and a blank page. Write through.
 *   SUMMARIES written once per article, never updated. Each costs a full Claude
 *             turn to regenerate, so it is the most expensive thing to lose.
 *             Write through.
 *   POSITIONS written on EVERY page turn, re-serialising the whole map each
 *             time. A bridge hop per swipe makes paging feel laggy, so these
 *             are debounced — see `debouncedKV`.
 *
 * Routing is by key prefix, which is why this sits above `store.ts` rather than
 * inside it: `store.ts` owns the key names and the mechanics, this owns policy.
 */

import {
  localKV, hostKV, layeredKV, debouncedKV,
  K_PROGRESS, type KV, type FlushableKV, type HostStore,
} from './store';

/**
 * Route writes for `slowKeys` to one KV and everything else to another.
 *
 * Reads go to whichever KV owns the key, so a value is always read back from
 * the layer that wrote it.
 */
function routed(match: (key: string) => boolean, matched: KV, rest: KV): KV {
  return {
    get: (k) => (match(k) ? matched : rest).get(k),
    set: (k, v) => (match(k) ? matched : rest).set(k, v),
  };
}

/** True for keys whose writes should be coalesced rather than written through. */
const isDeferred = (key: string): boolean => key === K_PROGRESS;

export type AppStorage = {
  /** Pass to `AppDeps.kv`. */
  kv: KV;
  /** Force pending position writes out. Await before the app goes away. */
  flush(): Promise<void>;
};

/**
 * Storage backed only by the webview.
 *
 * Used before the bridge exists — and it is all the phone ever has when the
 * glasses are not connected, or when the app is opened in a plain browser.
 * Nothing here survives the host closing the app; `withHost` fixes that.
 */
export function localStorageOnly(): AppStorage {
  return { kv: localKV(), flush: async () => {} };
}

/**
 * Storage backed by the HOST, mirrored to the webview.
 *
 * `main.ts` builds this once the bridge exists — it is the only file that may
 * touch the SDK, so the two host methods arrive here as plain functions and
 * this module stays unit-testable.
 */
export function withHost(host: HostStore, delayMs?: number): AppStorage {
  const mirror = localKV();
  const durable = layeredKV(hostKV(host), mirror);
  const deferred: FlushableKV = debouncedKV(hostKV(host), mirror, delayMs);
  return {
    kv: routed(isDeferred, deferred, durable),
    flush: () => deferred.flush(),
  };
}
