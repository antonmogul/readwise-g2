/**
 * @vitest-environment happy-dom
 *
 * The mirror is `localStorage`; under `node` these would pass vacuously.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

function fakeHost(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: vi.fn(async (k: string) => data.get(k) ?? ''),
    set: vi.fn(async (k: string, v: string) => { data.set(k, v); return true; }),
  };
}

/** A fresh module graph per test: the settings are module state, as on-device. */
async function load(host: ReturnType<typeof fakeHost>) {
  vi.resetModules();
  const token = await import('../readwise/token');
  token.useHostStore(host);
  return import('./settings');
}

describe('Claude settings', () => {
  beforeEach(() => localStorage.clear());

  it('survive the app closing: saved to the host, read back on the next launch', async () => {
    const host = fakeHost();
    let s = await load(host);
    await s.saveClaude({ apiKey: 'sk-ant-1', model: 'claude-haiku-5-5' });
    expect(s.readClaude()).toEqual({ apiKey: 'sk-ant-1', model: 'claude-haiku-5-5' });
    localStorage.clear(); // the webview copy does not survive
    s = await load(host);
    expect(await s.hydrateClaude()).toEqual({ apiKey: 'sk-ant-1', model: 'claude-haiku-5-5' });
  });

  it('removing the key removes it everywhere, so it cannot come back', async () => {
    const host = fakeHost();
    let s = await load(host);
    await s.saveClaude({ apiKey: 'sk-ant-1', model: 'claude-opus-5-5' });
    await s.saveClaude(null);
    expect(s.readClaude()).toBeNull();
    expect(localStorage.getItem(s.CLAUDE_KEY)).toBeFalsy();
    s = await load(host);
    expect(await s.hydrateClaude()).toBeNull();
  });

  it('is not configured by default', async () => {
    const s = await load(fakeHost());
    expect(await s.hydrateClaude()).toBeNull();
  });
});
