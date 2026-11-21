/**
 * The Readwise token: durable storage, read synchronously.
 *
 * WHY THIS FILE EXISTS. The token was written to `localStorage`, which the Even
 * Hub webview does not preserve across launches — so every open asked for it
 * again. The durable store is the host's, reached through
 * `bridge.get/setLocalStorage`, and that is ASYNC. But `readToken()` is called
 * synchronously on the render path in both shells (`main.ts` builds `AppDeps`
 * per call; the phone reads it during mount), so it cannot become a promise
 * without rippling through every caller.
 *
 * The resolution is a write-through cache with three layers:
 *
 *   1. an in-memory value — synchronous, what `readToken()` returns;
 *   2. the HOST store — durable, async, the source of truth across launches;
 *   3. `localStorage` — a same-session mirror, so a reload has the token before
 *      the host answers, and so the phone still works in a plain browser with
 *      no bridge at all.
 *
 * `hydrate()` fills (1) from (2)/(3) once at startup; `saveToken()` writes all
 * three. Between mount and hydration the app runs on the mirror, which is why
 * the mirror is kept rather than dropped as redundant.
 */

import { localKV, hostKV, layeredKV, type KV } from './store';

export const TOKEN_KEY = 'rw.token';

/**
 * One durable string, read synchronously: the three layers above, for any key.
 *
 * The Readwise token was the first value that had to survive a relaunch AND be
 * readable on the render path. The Claude settings are the second, with the
 * same constraints, so the mechanics are shared rather than copied.
 */
export type DurableString = {
  /** The synchronous value: the cache once hydrated, else the mirror, else the fallback. */
  read(): string;
  /** True once `hydrate()` has settled. */
  ready(): boolean;
  hydrate(): Promise<string>;
  /** Set synchronously, then write through. `''` clears it. */
  save(value: string): Promise<void>;
};

/** Where durable writes go. Plain `localStorage` until `main.ts` supplies the host. */
let store: KV = localKV();

/**
 * Point every durable string at the host-backed store.
 *
 * Called by `main.ts` once the bridge exists. Layered over `localStorage` so
 * the mirror keeps being written, and so a token saved by an older build is
 * migrated into durable storage on first read rather than being lost.
 */
export function useHostStore(host: Parameters<typeof hostKV>[0]): void {
  store = layeredKV(hostKV(host), localKV());
}

export function durableString(key: string, fallback: () => string = () => ''): DurableString {
  /**
   * `null` means "not yet hydrated" and is distinct from `''`, which means
   * "hydrated, and there is genuinely nothing saved". The phone uses that
   * difference to show a neutral checking state instead of flashing the setup
   * prompt at a user who already has a token saved.
   */
  let cached: string | null = null;

  const read = (): string => {
    if (cached !== null) return cached;
    try {
      const mirrored = globalThis.localStorage?.getItem(key);
      if (mirrored) return mirrored;
    } catch { /* storage unavailable — fall through */ }
    return fallback();
  };

  return {
    read,
    ready: () => cached !== null,
    /**
     * PRECEDENCE: a stored empty value never overwrites a value the mirror or
     * the fallback still holds. The host returning `''` means "nothing saved
     * here", not "it was cleared", and treating those the same would wipe a
     * token pasted while the bridge was unavailable.
     */
    async hydrate() {
      const stored = await store.get(key).catch(() => null);
      cached = stored || read();
      return cached;
    },
    /**
     * The cache is set FIRST and synchronously: the save action repaints
     * immediately and must not race the durable write, which crosses the bridge.
     */
    save(value: string) {
      cached = value;
      // A cleared value must clear the mirror too, or `read()` before the next
      // hydrate would bring it back from there.
      if (!value) {
        try { globalThis.localStorage?.removeItem(key); } catch { /* unavailable */ }
      }
      return store.set(key, value).catch(() => {});
    },
  };
}

/**
 * Build-time fallback, for driving the app against a local stand-in during
 * development. Absent from a production build, so a packaged .ehpk still holds
 * no credential and still requires the token to be entered on-device.
 */
const envToken = (): string =>
  (import.meta.env?.VITE_READWISE_TOKEN as string | undefined) ?? '';

const token = durableString(TOKEN_KEY, envToken);

/**
 * Read the token from the synchronous cache.
 *
 * Before hydration this falls back to the mirror, so the very first render
 * after a reload still has a token when one was saved this session.
 */
export const readToken = (): string => token.read();

/** True once `hydrate()` has settled, so the UI can distinguish "none" from "not yet". */
export const tokenReady = (): boolean => token.ready();

/**
 * Load the token from durable storage into the synchronous cache. Resolves to
 * the token so a caller can repaint with it. Safe to call before `useHostStore`.
 */
export const hydrate = (): Promise<string> => token.hydrate();

/** Persist the token, and make it readable synchronously from this moment. */
export const saveToken = (value: string): Promise<void> => token.save(value);
