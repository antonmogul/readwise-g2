import { describe, it, expect } from 'vitest';
import {
  noFilter, matchesQuery, sites, filterDocs, readingTime, progressPct,
  savedLabel, emptyMessage, libraryVM,
} from './views';
import type { Doc } from '../readwise/client';

const doc = (over: Partial<Doc> & { id: string }): Doc => ({
  title: 'Deep Work', author: 'Cal Newport', site_name: 'The Guardian',
  url: 'u', category: 'article', location: 'later', reading_progress: 0,
  reading_time: '7 mins', saved_at: '2026-08-06T10:00:00Z', summary: null, ...over,
});

const NOW = new Date('2026-08-06T18:00:00Z');

describe('matchesQuery', () => {
  it('matches everything when the query is empty', () => {
    expect(matchesQuery(doc({ id: '1' }), '  ')).toBe(true);
  });

  it('matches title, author and publication', () => {
    const d = doc({ id: '1' });
    expect(matchesQuery(d, 'deep')).toBe(true);
    expect(matchesQuery(d, 'newport')).toBe(true);
    expect(matchesQuery(d, 'guardian')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matchesQuery(doc({ id: '1' }), 'DEEP WORK')).toBe(true);
  });

  it('rejects a non-match', () => {
    expect(matchesQuery(doc({ id: '1' }), 'zebra')).toBe(false);
  });

  it('tolerates missing author and publication', () => {
    const d = doc({ id: '1', author: null, site_name: null });
    expect(matchesQuery(d, 'deep')).toBe(true);
    expect(matchesQuery(d, 'guardian')).toBe(false);
  });
});

describe('sites', () => {
  it('counts publications, most-used first', () => {
    const docs = [
      doc({ id: '1', site_name: 'A' }),
      doc({ id: '2', site_name: 'B' }),
      doc({ id: '3', site_name: 'B' }),
    ];
    expect(sites(docs)).toEqual([{ name: 'B', count: 2 }, { name: 'A', count: 1 }]);
  });

  it('ignores documents with no publication', () => {
    expect(sites([doc({ id: '1', site_name: null })])).toEqual([]);
  });

  // A chip for a YouTube channel would filter to zero results, because every
  // one of its documents is dropped by the article filter.
  it('ignores publications that only carry non-articles', () => {
    const mixed = [
      doc({ id: '1', site_name: 'Aeon' }),
      doc({ id: 'v', site_name: 'YouTube', category: 'video' }),
    ];
    expect(sites(mixed).map((s) => s.name)).toEqual(['Aeon']);
  });

  it('breaks count ties alphabetically', () => {
    const docs = [doc({ id: '1', site_name: 'Zed' }), doc({ id: '2', site_name: 'Ant' })];
    expect(sites(docs).map((s) => s.name)).toEqual(['Ant', 'Zed']);
  });
});

describe('filterDocs', () => {
  const docs = [
    doc({ id: '1', title: 'Alpha', site_name: 'A' }),
    doc({ id: '2', title: 'Beta', site_name: 'B' }),
  ];

  it('returns everything under no filter', () => {
    expect(filterDocs(docs, noFilter())).toHaveLength(2);
  });

  // Caught in the simulator: the three view selectors filter by category
  // themselves, so 'all' was the one path where a video reached the screen.
  // "Written articles only" is an app-wide boundary, not a glasses-only one.
  it('drops non-article categories', () => {
    const mixed = [...docs, doc({ id: 'v', title: 'A Video', category: 'video' })];
    expect(filterDocs(mixed, noFilter()).map((d) => d.id)).toEqual(['1', '2']);
  });

  it('filters by publication', () => {
    expect(filterDocs(docs, { ...noFilter(), site: 'B' }).map((d) => d.id)).toEqual(['2']);
  });

  it('combines query and publication', () => {
    expect(filterDocs(docs, { ...noFilter(), site: 'A', query: 'beta' })).toHaveLength(0);
  });
});

describe('labels', () => {
  it('omits reading time when Readwise could not estimate it', () => {
    expect(readingTime(doc({ id: '1', reading_time: null }))).toBe('');
    expect(readingTime(doc({ id: '1', reading_time: '7 mins' }))).toBe('7 min');
  });

  it('clamps progress into a percentage', () => {
    expect(progressPct(doc({ id: '1', reading_progress: 0.456 }))).toBe(46);
    expect(progressPct(doc({ id: '1', reading_progress: 2 }))).toBe(100);
    expect(progressPct(doc({ id: '1', reading_progress: -1 }))).toBe(0);
  });

  it('drops the year for the current year', () => {
    expect(savedLabel(doc({ id: '1', saved_at: '2026-08-06T10:00:00Z' }), NOW))
      .toBe('6 Aug');
  });

  it('keeps the year for older documents', () => {
    expect(savedLabel(doc({ id: '1', saved_at: '2024-03-02T10:00:00Z' }), NOW))
      .toContain('2024');
  });

  it('returns nothing for an unparseable date rather than "Invalid Date"', () => {
    expect(savedLabel(doc({ id: '1', saved_at: 'nope' }), NOW)).toBe('');
  });
});

describe('emptyMessage', () => {
  // A filtered-to-nothing list is fixed by clearing the filter; an empty
  // library is not. Saying the same thing for both is unhelpful.
  it('distinguishes an empty library from an empty filter result', () => {
    expect(emptyMessage(0, noFilter())).toContain('library');
    expect(emptyMessage(50, { ...noFilter(), query: 'zebra' })).toContain('zebra');
    expect(emptyMessage(50, { ...noFilter(), site: 'The Guardian' })).toContain('Guardian');
  });
});

describe('libraryVM', () => {
  const all = [
    doc({ id: '1', title: 'Alpha', site_name: 'A' }),
    doc({ id: '2', title: 'Beta', site_name: 'B', reading_progress: 0.5 }),
  ];

  it('shows the whole library under the all view', () => {
    const vm = libraryVM(all, [], noFilter(), { stale: false, syncedAt: null });
    expect(vm.docs).toHaveLength(2);
    expect(vm.total).toBe(2);
    expect(vm.empty).toBeNull();
  });

  it('excludes non-articles from both the list and the total', () => {
    const mixed = [...all, doc({ id: 'v', category: 'video' })];
    const vm = libraryVM(mixed, [], noFilter(), { stale: false, syncedAt: null });
    expect(vm.docs.map((d) => d.id)).toEqual(['1', '2']);
    // "2 of 3" would claim a total including something never shown.
    expect(vm.total).toBe(2);
  });

  it('uses the pre-selected documents for a specific view', () => {
    const vm = libraryVM(all, [all[1]], { ...noFilter(), view: 'halfread' },
      { stale: false, syncedAt: null });
    expect(vm.docs.map((d) => d.id)).toEqual(['2']);
  });

  it('offers publication chips from the whole library, not the filtered set', () => {
    const vm = libraryVM(all, [], { ...noFilter(), site: 'A' },
      { stale: false, syncedAt: null });
    expect(vm.sites.map((s) => s.name).sort()).toEqual(['A', 'B']);
  });

  it('reports why the list is empty', () => {
    const vm = libraryVM(all, [], { ...noFilter(), query: 'zebra' },
      { stale: false, syncedAt: null });
    expect(vm.empty).toContain('zebra');
  });

  // Showing cached data without saying it is cached is the failure the
  // offline acceptance check exists to catch.
  it('names the sync time when serving stale data', () => {
    const vm = libraryVM(all, [], noFilter(), { stale: true, syncedAt: '18:20' });
    expect(vm.staleNote).toContain('18:20');
  });

  it('says so when nothing was ever cached', () => {
    const vm = libraryVM([], [], noFilter(), { stale: true, syncedAt: null });
    expect(vm.staleNote).toContain('no library cached');
  });

  it('has no stale note when the data is current', () => {
    expect(libraryVM(all, [], noFilter(), { stale: false, syncedAt: '18:20' }).staleNote)
      .toBeNull();
  });
});
