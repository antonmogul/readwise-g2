/**
 * Phone view models — every decision the phone UI makes, as pure functions.
 *
 * `render.ts` turns these into elements and holds no logic of its own. That
 * split is what makes the phone surface testable: filtering, search, counts
 * and empty states are asserted here without a DOM.
 *
 * The phone is where the library is actually BROWSABLE. The glasses offer
 * three narrow ways in because 576×288 cannot hold more; the phone has the
 * full list, tags, publication, date saved, filtering and search — everything
 * the glasses deliberately omit.
 */

import { readingMinutes, type Doc } from '../readwise/client';
import { isArticle, type ViewKey } from '../readwise/views';

export type PhoneRoute =
  | { name: 'library' }
  | { name: 'article'; id: string }
  | { name: 'settings' };

/** Library filters. All axes combine; each is independently optional. */
export type Filter = {
  /** Free text over title, author and publication. */
  query: string;
  /** One of the three glasses views, or 'all' for the full library. */
  view: ViewKey | 'all';
  /** Publication name, exactly as Readwise reports it. */
  site: string | null;
};

export const noFilter = (): Filter => ({ query: '', view: 'all', site: null });

/** Case- and punctuation-insensitive enough for a phone search box. */
const norm = (s: string) => s.toLowerCase().trim();

export function matchesQuery(d: Doc, query: string): boolean {
  const q = norm(query);
  if (!q) return true;
  return [d.title, d.author, d.site_name]
    .filter(Boolean)
    .some((f) => norm(String(f)).includes(q));
}

/**
 * Publications present in the library, most-used first.
 *
 * Drives the filter chips. Sorted by count rather than alphabetically because
 * the useful chips are the publications that actually dominate the queue.
 */
export function sites(docs: Doc[]): { name: string; count: number }[] {
  const acc = new Map<string, number>();
  for (const d of docs) {
    // Articles only, or the chips advertise a publication (a YouTube channel,
    // say) whose every document is filtered out — a chip that filters to zero.
    if (!isArticle(d) || !d.site_name) continue;
    acc.set(d.site_name, (acc.get(d.site_name) ?? 0) + 1);
  }
  return [...acc.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Apply the filter.
 *
 * `view` is applied by the CALLER passing pre-selected documents for a view,
 * because the three view selectors need a clock and a random source that this
 * function should not own. Here we handle only query and site.
 */
export function filterDocs(docs: Doc[], filter: Filter): Doc[] {
  return docs
    // Written articles only — the same rule the glasses apply. The three view
    // selectors filter by category themselves, so the 'all' view was the one
    // path where a video or PDF could reach the screen. "Written articles only"
    // is an app-wide boundary, not a glasses-only one.
    .filter(isArticle)
    .filter((d) => (filter.site ? d.site_name === filter.site : true))
    .filter((d) => matchesQuery(d, filter.query));
}

/** Human reading-time label. Null reading_time is common on unparsed pages. */
export const readingTime = (d: Doc): string => {
  const minutes = readingMinutes(d);
  return minutes ? `${minutes} min` : '';
};

/** Progress as a percentage, for the progress bar. */
export const progressPct = (d: Doc): number =>
  Math.round(Math.min(1, Math.max(0, d.reading_progress)) * 100);

/** "Saved 6 Aug", relative-free because absolute dates are less ambiguous. */
export function savedLabel(d: Doc, now: Date): string {
  const date = new Date(d.saved_at);
  if (Number.isNaN(date.getTime())) return '';
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/**
 * What to show when a list is empty — and crucially, WHY it is empty.
 *
 * A filtered-to-nothing list and a genuinely empty library need different
 * messages: the first is fixed by clearing the filter, the second is not.
 */
export function emptyMessage(total: number, filter: Filter): string {
  if (total === 0) return 'Nothing in your library yet.';
  if (filter.query) return `Nothing matches “${filter.query}”.`;
  if (filter.site) return `Nothing from ${filter.site}.`;
  return 'Nothing here.';
}

export type LibraryVM = {
  docs: Doc[];
  total: number;
  sites: { name: string; count: number }[];
  empty: string | null;
  /** Shown when serving cached data, so the UI never implies it is current. */
  staleNote: string | null;
};

export function libraryVM(
  all: Doc[],
  viewDocs: Doc[],
  filter: Filter,
  opts: { stale: boolean; syncedAt: string | null },
): LibraryVM {
  const base = (filter.view === 'all' ? all : viewDocs).filter(isArticle);
  const docs = filterDocs(base, filter);
  return {
    docs,
    // Counted AFTER the article filter, so "3 of 6" cannot claim a total that
    // includes documents this app will never show.
    total: base.length,
    sites: sites(all),
    empty: docs.length === 0 ? emptyMessage(base.length, filter) : null,
    staleNote: opts.stale
      ? opts.syncedAt
        ? `Offline — showing your library as of ${opts.syncedAt}`
        : 'Offline — no library cached yet'
      : null,
  };
}
