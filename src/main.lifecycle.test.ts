// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { MENU } from './glass/screens';
import { K_PROGRESS } from './readwise/store';
import type { LibraryState } from './app';

const harness = vi.hoisted(() => ({
  event: (_event: any) => {},
  host: new Map<string, string>(),
  create: vi.fn(async (_page: any) => 0),
  rebuild: vi.fn(async (_page: any) => true),
  upgrade: vi.fn(async (_update: any) => true),
  audio: vi.fn(async (_open: boolean) => true),
  load: vi.fn<() => Promise<LibraryState>>(),
}));
vi.mock('@evenrealities/even_hub_sdk', async (original) => ({
  ...await original<object>(),
  waitForEvenAppBridge: async () => ({
    getLocalStorage: async (key: string) => harness.host.get(key) ?? '',
    setLocalStorage: async (key: string, value: string) => { harness.host.set(key, value); return true; },
    createStartUpPageContainer: harness.create,
    rebuildPageContainer: harness.rebuild,
    textContainerUpgrade: harness.upgrade,
    onEvenHubEvent: (callback: typeof harness.event) => { harness.event = callback; return () => {}; },
    audioControl: harness.audio,
  }),
}));
vi.mock('./phone/app', () => ({ mountPhone: () => null }));
vi.mock('./readwise/token', () => ({ readToken: () => 'test', useHostStore: () => {}, hydrate: async () => 'test' }));
vi.mock('./brain/settings', () => ({ readClaude: () => null, hydrateClaude: async () => null, saveClaude: async () => {} }));
vi.mock('./app', async (original) => ({
  ...await original<object>(),
  loadLibraryState: harness.load,
  loadArticleText: async () => ({
    text: 'A long article worth continuing. '.repeat(300), error: null,
    cachedSummary: 'The summary.', resume: 0,
  }),
}));

it('shows startup feedback, saves on host/phone exits, and never treats launch as permission to listen', async () => {
  localStorage.clear();
  let loaded!: (library: LibraryState) => void;
  harness.load.mockImplementation(() => new Promise((resolve) => { loaded = resolve; }));
  const boot = import('./main');
  // This first wait includes the cold import of main's whole module graph, which
  // under a parallel full-suite run sometimes passed vitest's 1s default — the
  // test then failed on machine load, not on behaviour. The ordering it checks
  // (first frame before the library) does not depend on how long that takes.
  await vi.waitFor(() => expect(harness.create).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  expect(JSON.stringify(harness.create.mock.calls[0])).toContain('Loading your library');
  expect(harness.audio).not.toHaveBeenCalled();
  const initial: LibraryState = { docs: [{
    id: 'article', title: 'Resume me', author: null, site_name: null,
    url: 'https://example.com/article', category: 'article', location: 'later',
    reading_progress: 0, reading_time: '8 mins', saved_at: new Date().toISOString(), summary: null,
  }], fetchedAt: Date.now(), stale: false, error: null };
  loaded(initial);
  await boot;
  const emit = async (event: any) => {
    harness.event(event);
    // Drain bridge + input promise queues, without advancing debounce timers.
    for (let i = 0; i < 60; i++) await Promise.resolve();
  };
  const homeRebuilds = harness.rebuild.mock.calls.length;
  await emit({ textEvent: { eventType: 2 } });
  await emit({ textEvent: { eventType: 1 } });
  expect(harness.upgrade).toHaveBeenCalled(); // retain v0.5.1 in-place focus
  expect(harness.rebuild).toHaveBeenCalledTimes(homeRebuilds);
  await emit({ sysEvent: { eventType: 0 } }); // Home → Recent
  await emit({ sysEvent: { eventType: 0 } }); // Recent → summary
  await emit({ sysEvent: { eventType: 0 } }); // summary → reader
  await emit({ textEvent: { eventType: 2 } }); // next sheet
  expect(harness.host.has(K_PROGRESS)).toBe(false);
  const page = harness.rebuild.mock.calls.length;
  await emit({ sysEvent: { eventType: 7 } });
  expect(JSON.parse(harness.host.get(K_PROGRESS)!).article).toBeGreaterThan(0);
  expect(harness.rebuild).toHaveBeenCalledTimes(page); // no scroll-resetting redraw
  const first = JSON.parse(harness.host.get(K_PROGRESS)!).article;

  await emit({ textEvent: { eventType: 2 } });
  window.dispatchEvent(new Event('pagehide'));
  await vi.waitFor(() => expect(JSON.parse(harness.host.get(K_PROGRESS)!).article).toBeGreaterThan(first));
  const second = JSON.parse(harness.host.get(K_PROGRESS)!).article;
  await emit({ textEvent: { eventType: 2 } });
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(JSON.parse(harness.host.get(K_PROGRESS)!).article).toBeGreaterThan(second));
  hidden.mockRestore();
  expect(harness.audio).not.toHaveBeenCalled();

  // A refresh started before another sheet turn must not publish its old
  // zero-progress snapshot over the local reading position.
  await emit({ menuItemClickEvent: { itemID: MENU.refresh } });
  await emit({ textEvent: { eventType: 2 } });
  loaded(initial);
  await emit({});
  await emit({ menuItemClickEvent: { itemID: MENU.continue } });
  const continued = JSON.stringify(harness.rebuild.mock.calls.at(-1));
  expect(continued).toContain('Continue reading');
  expect(continued).toContain('Resume me');

  await emit({ menuItemClickEvent: { itemID: MENU.ask } });
  expect(harness.audio).toHaveBeenLastCalledWith(true, 'glasses');
  await emit({ sysEvent: { eventType: 6 } });
  expect(harness.audio).toHaveBeenLastCalledWith(false);
  expect(harness.create).toHaveBeenCalledTimes(1);
});
