/**
 * The public build — the default: no `VITE_BOARD_BASE`.
 *
 * A personal build keeps voice Ask and its Brain board; the public one has no
 * board, so it must never show a door that leads there.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

let nav: typeof import('./glass/nav');
let S: typeof import('./glass/screens');
let summarise: typeof import('./brain/summarise');
let digest: typeof import('./brain/digest');

beforeAll(async () => {
  vi.stubEnv('VITE_BOARD_BASE', '');
  vi.resetModules();
  nav = await import('./glass/nav');
  S = await import('./glass/screens');
  summarise = await import('./brain/summarise');
  digest = await import('./brain/digest');
});
afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });

const overview = {
  week: [0, 2, 5, 1, 0, 4, 3], queued: 42, queueMinutes: 610, inProgress: 7,
  syncedAt: '10:23', stale: false, feed: 'not-opened' as const,
  counts: { recent: 20, today: 3, halfread: 7, surprise: 20, quick: 8, long: 14 },
};

describe('public build', () => {
  it('has no board: nothing to reach, and no tailnet address to ship', () => {
    expect(summarise.boardEnabled()).toBe(false);
    expect(summarise.boardBase()).toBe('');
  });

  it('Home has no Ask row, and still draws valid screens at every focus', () => {
    expect(nav.HOME_VIEWS).not.toContain('ask');
    expect(nav.HOME_VIEWS.at(-1)).toBe('surprise');
    for (let f = 0; f < nav.HOME_VIEWS.length; f++) {
      expect(() => S.home(overview, f)).not.toThrow();
    }
    expect(JSON.stringify(S.home(overview, 0))).not.toMatch(/Ask your library/);
  });

  it('no menu offers Ask your library', () => {
    expect(S.homeMenu().map((m) => m.itemName)).not.toContain('Ask your library');
    expect(S.navigationMenu('recent').map((m) => m.itemName)).not.toContain('Ask your library');
  });

  it('is called Readwise, like the service it reads', () => {
    const header = (s: ReturnType<typeof S.loading>) => s.containers.find((c) => c.containerName === 'header')!.content;
    expect(header(S.loading())).toBe('Readwise');
    expect(header(S.home(overview, 0))).toBe('Readwise');
  });

  // The privacy policy says the app talks only to Readwise and Anthropic. With
  // no key in the public build, nothing at all may be sent for AI.
  it('without a Claude key, AI features send nothing anywhere', async () => {
    const f = vi.fn();
    const doc = { id: 'd1', title: 'Headline', site_name: 'Wired' } as never;
    expect(await digest.triage([doc], { fetchImpl: f as unknown as typeof fetch })).toBeNull();
    const s = await summarise.summarise('T', null, 'Body.', { fetchImpl: f as unknown as typeof fetch });
    expect(s.fromBrain).toBe(false);
    expect(s.error).toBe('Add a Claude key in Settings for AI features');
    expect(f).not.toHaveBeenCalled();
  });

  it('a stray Ask selection goes nowhere', () => {
    const home = { name: 'home', focus: 0 } as const;
    const ctx = {
      rows: [], pages: 1, summaryPages: 1, resumePage: 0, sections: [], digestLoaded: false,
      digestError: false, digestStale: false, answerPages: 1, answerDocs: [],
    };
    expect(nav.step(home, ctx, 'navAsk')).toEqual({ route: home, effect: { kind: 'none' } });
  });
});
