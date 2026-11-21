/**
 * @vitest-environment happy-dom
 *
 * The mirror layer is `localStorage`, which does not exist under the default
 * `node` environment — the assertions here would optional-chain past it and
 * pass without testing anything.
 *
 * Token persistence.
 *
 * This is the guard on the bug that made the app ask for the token on every
 * launch: it was written to the webview's `localStorage`, which the Even Hub
 * host does not preserve. These tests assert that the durable host store is
 * written, is preferred on read, and — the part that is easy to regress — that
 * an empty host value never wipes a token we still hold.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { hostKV, layeredKV, memoryKV, type KV } from './store';

/** A host store that survives "closing the app", unlike the webview's own. */
function fakeHost(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: vi.fn(async (k: string) => data.get(k) ?? ''),
    set: vi.fn(async (k: string, v: string) => { data.set(k, v); return true; }),
  };
}

describe('hostKV', () => {
  it('reads and writes through the host', async () => {
    const host = fakeHost();
    const kv = hostKV(host);
    await kv.set('rw.token', 'abc');
    expect(host.set).toHaveBeenCalledWith('rw.token', 'abc');
    expect(await kv.get('rw.token')).toBe('abc');
  });

  it('normalises the host empty string to null', async () => {
    // The host returns '' for a key it does not have. Callers check for null.
    expect(await hostKV(fakeHost()).get('missing')).toBeNull();
  });

  it('degrades to null when the host throws', async () => {
    const kv = hostKV({
      get: async () => { throw new Error('bridge down'); },
      set: async () => { throw new Error('bridge down'); },
    });
    expect(await kv.get('rw.token')).toBeNull();
    // A failed durable write must not reject — it would break the save action.
    await expect(kv.set('rw.token', 'abc')).resolves.toBeUndefined();
  });
});

describe('layeredKV', () => {
  let primary: KV;
  let backup: KV;

  beforeEach(() => {
    primary = memoryKV();
    backup = memoryKV();
  });

  it('writes to both layers', async () => {
    await layeredKV(primary, backup).set('rw.token', 'abc');
    expect(await primary.get('rw.token')).toBe('abc');
    expect(await backup.get('rw.token')).toBe('abc');
  });

  it('prefers the primary', async () => {
    await primary.set('rw.token', 'durable');
    await backup.set('rw.token', 'mirror');
    expect(await layeredKV(primary, backup).get('rw.token')).toBe('durable');
  });

  it('falls back to the backup and backfills it forward', async () => {
    // This is the migration path: a token saved by the OLD build exists only
    // in localStorage. It must be readable, and must land in durable storage
    // so the user never has to paste it again.
    await backup.set('rw.token', 'legacy');
    const kv = layeredKV(primary, backup);
    expect(await kv.get('rw.token')).toBe('legacy');
    expect(await primary.get('rw.token')).toBe('legacy');
  });

  it('survives a primary that throws on read', async () => {
    const broken: KV = {
      get: async () => { throw new Error('no bridge'); },
      set: async () => { throw new Error('no bridge'); },
    };
    await backup.set('rw.token', 'mirror');
    expect(await layeredKV(broken, backup).get('rw.token')).toBe('mirror');
  });
});

describe('token module', () => {
  beforeEach(() => {
    vi.resetModules();
    globalThis.localStorage?.clear?.();
  });

  it('returns the saved token synchronously after a save', async () => {
    const token = await import('./token');
    await token.saveToken('abc');
    // Synchronous: the render path calls this and cannot await.
    expect(token.readToken()).toBe('abc');
  });

  it('hydrates from the host store across a launch', async () => {
    const host = fakeHost({ 'rw.token': 'durable' });
    const token = await import('./token');
    token.useHostStore(host);
    expect(await token.hydrate()).toBe('durable');
    expect(token.readToken()).toBe('durable');
    expect(token.tokenReady()).toBe(true);
  });

  it('is not ready before hydration, so the UI can hold its prompt', async () => {
    const token = await import('./token');
    expect(token.tokenReady()).toBe(false);
  });

  it('does not let an empty host value wipe a token saved this session', async () => {
    // The host answering '' means "nothing stored here", NOT "cleared". A user
    // who pastes a token while the bridge is unavailable must not lose it the
    // moment the bridge connects and reports empty.
    const host = fakeHost();
    const token = await import('./token');
    token.useHostStore(host);
    await token.saveToken('pasted');
    host.data.delete('rw.token');
    expect(await token.hydrate()).toBe('pasted');
  });

  it('persists through the host, not just the webview', async () => {
    const host = fakeHost();
    const token = await import('./token');
    token.useHostStore(host);
    await token.saveToken('abc');
    // The durable store is what a relaunch reads. If this assertion fails the
    // original bug is back: the token lives only where the host will clear it.
    expect(host.data.get('rw.token')).toBe('abc');
  });
});
