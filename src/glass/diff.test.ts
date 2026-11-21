import { describe, it, expect } from 'vitest';
import { diffScreens } from './diff';
import { home, list, summary, digest } from './screens';
import type { Doc } from '../readwise/client';
import type { Screen } from './layout';

const doc = (id: string): Doc => ({
  id, title: `Article ${id}`, author: 'A', site_name: 'S', url: 'u', category: 'article',
  location: 'later', reading_progress: 0, reading_time: '5 mins', saved_at: '2026-08-06T10:00:00Z', summary: null,
});
const docs = ['a', 'b', 'c', 'd'].map(doc);

const overview = {
  week: [0, 1, 2, 0, 1, 0, 3], queued: 4, queueMinutes: 30, inProgress: 1, syncedAt: '10:00', stale: false,
  feed: 'not-opened' as const, counts: { recent: 4, today: 0, halfread: 1, surprise: 4, quick: 2, long: 0 },
};

describe('diffScreens', () => {
  it('needs a rebuild when nothing is up yet', () => {
    expect(diffScreens(null, home(overview, 0))).toEqual({ kind: 'rebuild' });
  });

  it('says so when the screens are identical', () => {
    expect(diffScreens(home(overview, 1), home(overview, 1))).toEqual({ kind: 'same' });
  });

  // The point of the exercise: a swipe on Home or a list moves focus without
  // a page rebuild. Only the rows whose cursor or brightness changed go up.
  it('upgrades a focus move on Home — two tiles, nothing else', () => {
    const d = diffScreens(home(overview, 0), home(overview, 1));
    expect(d.kind).toBe('upgrade');
    if (d.kind !== 'upgrade') return;
    expect(d.changed.map((c) => c.containerName)).toEqual(['view0', 'view1']);
    expect(d.changed[1].content.startsWith('▶ ')).toBe(true);
    expect(d.changed[0].content.startsWith('▶ ')).toBe(false);
  });

  it('upgrades a focus move within a list window, header counter included', () => {
    const d = diffScreens(list('recent', docs, 0), list('recent', docs, 1));
    expect(d.kind).toBe('upgrade');
    if (d.kind !== 'upgrade') return;
    expect(d.changed.map((c) => c.containerName)).toEqual(['header', 'row0', 'row1']);
  });

  it('upgrades a notice landing in a footer', () => {
    const d = diffScreens(list('recent', docs, 0), list('recent', docs, 0, '■ Archived in Readwise'));
    expect(d).toMatchObject({ kind: 'upgrade' });
    if (d.kind === 'upgrade') expect(d.changed.map((c) => c.containerName)).toEqual(['footer']);
  });

  it('upgrades a summary arriving on the sheet already up', () => {
    const d = diffScreens(
      summary(doc('a'), 'Summarising…', true, true),
      summary(doc('a'), 'The gist.', true, false),
    );
    expect(d).toMatchObject({ kind: 'upgrade' });
  });

  // Home scrolls its dashboard away as a slot: the container SET changes.
  it('rebuilds when a window scrolls and the container set changes', () => {
    expect(diffScreens(home(overview, 2), home(overview, 3))).toEqual({ kind: 'rebuild' });
  });

  it('rebuilds between different screens', () => {
    expect(diffScreens(home(overview, 0), list('recent', docs, 0))).toEqual({ kind: 'rebuild' });
    expect(diffScreens(list('recent', docs, 0), summary(doc('a'), 'g', true))).toEqual({ kind: 'rebuild' });
    expect(diffScreens(list('recent', docs, 0), list('recent', docs.slice(0, 2), 0))).toEqual({ kind: 'rebuild' });
  });

  it('rebuilds when the menu changes, since an upgrade cannot carry one', () => {
    const a = list('recent', docs, 0);
    const b: Screen = { ...a, menuItems: a.menuItems!.slice(1) };
    expect(diffScreens(a, b)).toEqual({ kind: 'rebuild' });
  });

  // Upgrade cannot change geometry, borders, padding or capture (SDK typings).
  it('rebuilds on any change an upgrade cannot express', () => {
    const base = digest([{ name: 'AI', docs: docs.slice(0, 2), note: null }], 0, true);
    const tweak = (patch: Partial<Screen['containers'][number]>): Screen => ({
      ...base, containers: base.containers.map((c, i) => (i === 1 ? { ...c, ...patch } : c)),
    });
    for (const patch of [
      { borderWidth: 2 }, { borderColor: 15 }, { paddingLength: 2 }, { yPosition: 90 },
      { height: 62 }, { width: 500 }, { borderRadius: 0 }, { containerName: 'other' },
    ]) {
      expect(diffScreens(base, tweak(patch))).toEqual({ kind: 'rebuild' });
    }
  });
});
