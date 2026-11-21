/**
 * Focused ways into the library, as pure selectors over fetched documents.
 *
 * These are the product. The card's argument is that a 1,014-item `later`
 * queue is unbrowsable, so the app must not offer "browse" — it offers three
 * narrow questions with short answers:
 *
 *   Recent      — a dependable front door, including items older than today
 *   Today       — what I just captured, retained as a phone filter
 *   Continue    — started articles, ordered by cheapest to finish
 *   Surprise me — defeats the paralysis by REMOVING the choice
 *
 * All three are pure functions of a document array so they can be asserted
 * without a network. Filtering lives here, not in the fetch layer, because
 * the same fetched page feeds more than one view and the rate limit means we
 * cannot afford a request per view.
 */

import { readingMinutes, type Doc } from './client';

/** A list container holds 20 rows; past that the firmware scrolls badly. */
export const MAX_ROWS = 20;

export type ViewKey = 'recent' | 'today' | 'halfread' | 'surprise' | 'quick' | 'long';

export const VIEW_LABELS: Record<ViewKey, string> = {
  recent: 'Recently added',
  today: 'Today',
  halfread: 'Continue reading',
  surprise: 'Surprise me',
  quick: 'Quick reads',
  long: 'Long reads',
};

/**
 * Written articles only. PDFs, videos, tweets and epubs render badly at this
 * size and were explicitly ruled out — filtering here rather than trusting the
 * `category` query means a mislabelled document cannot leak into a list.
 */
export const isArticle = (d: Doc): boolean => d.category === 'article';

/** Local calendar day, not UTC — "today" means Anton's today. */
export function isSameLocalDay(iso: string, ref: Date): boolean {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return (
    d.getFullYear() === ref.getFullYear() &&
    d.getMonth() === ref.getMonth() &&
    d.getDate() === ref.getDate()
  );
}

/** Newest first — the most recently saved is the most likely to be wanted. */
const bySavedDesc = (a: Doc, b: Doc) =>
  new Date(b.saved_at).getTime() - new Date(a.saved_at).getTime();

/**
 * The predictable front door the first hardware build was missing.
 *
 * "Today" is useful as a filter but fails as the primary library: on a quiet
 * day it makes a healthy account look empty. Recent intentionally spans both
 * new and later because those are the two library locations already cached.
 */
export function recent(docs: Doc[]): Doc[] {
  return docs
    .filter(isArticle)
    .filter((d) => d.location === 'new' || d.location === 'later')
    .sort(bySavedDesc)
    .slice(0, MAX_ROWS);
}

export function today(docs: Doc[], now: Date): Doc[] {
  return docs
    .filter(isArticle)
    .filter((d) => isSameLocalDay(d.saved_at, now))
    .sort(bySavedDesc)
    .slice(0, MAX_ROWS);
}

/**
 * Bounds are exclusive at both ends and deliberately not 0..1:
 * below 0.05 the reader merely opened it (Readwise writes tiny progress on a
 * single scroll), and above 0.95 it is finished in every sense that matters.
 * Including either end would refill this list with noise and destroy the one
 * property that makes it useful — that it is SHORT.
 */
export const HALF_READ_MIN = 0.05;
export const HALF_READ_MAX = 0.95;

export function halfRead(docs: Doc[]): Doc[] {
  return docs
    .filter(isArticle)
    .filter((d) => d.reading_progress > HALF_READ_MIN && d.reading_progress < HALF_READ_MAX)
    // Most-progressed first: the nearly-finished are the cheapest to clear.
    .sort((a, b) => b.reading_progress - a.reading_progress)
    .slice(0, MAX_ROWS);
}

/**
 * Unstarted items from `later`, shuffled.
 *
 * `rand` is injected rather than calling Math.random directly so the shuffle
 * is deterministic under test — a random selector that cannot be asserted is
 * a selector that silently returns nothing.
 */
export function surprise(docs: Doc[], rand: () => number = Math.random): Doc[] {
  const pool = docs
    .filter(isArticle)
    .filter((d) => d.location === 'later')
    .filter((d) => d.reading_progress <= HALF_READ_MIN);

  // Fisher–Yates over a copy. Sorting by `rand() - 0.5` is a common shortcut
  // and is measurably biased, which matters when the whole point of the view
  // is that it is a fair draw from a thousand items.
  const out = [...pool];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.slice(0, MAX_ROWS);
}

/**
 * The article to open after archiving `id` out of a list, and the row it will
 * sit on once the archived one is pruned — or null to go back to the list.
 *
 * Shared by both surfaces, so "archive and move on" means the same thing on
 * the glasses and the phone. Next is the row BELOW: a list is read top-down,
 * so that is where the reader was heading anyway. At the end there is no next —
 * landing on the (shorter) list says so better than wrapping round to an
 * article skipped earlier.
 */
export function nextAfter(docs: readonly Doc[], id: string): { doc: Doc; index: number } | null {
  const i = docs.findIndex((d) => d.id === id);
  if (i < 0 || i + 1 >= docs.length) return null;
  return { doc: docs[i + 1], index: i };
}

/**
 * The held rows after the library changed under them — a refresh landing on
 * any screen. Order is kept and no selector is re-run (Surprise would
 * reshuffle under the focus cursor); each row is swapped for its fresh
 * document, and rows whose document no longer exists are dropped.
 */
export function reconcileRows(held: readonly Doc[], docs: readonly Doc[]): Doc[] {
  const fresh = new Map(docs.map((d) => [d.id, d]));
  return held.flatMap((d) => {
    const f = fresh.get(d.id);
    return f ? [f] : [];
  });
}

/**
 * Where focus lands after rows changed: on the same document when it is still
 * there, otherwise clamped into the list. Never an index past the end.
 */
export function focusOn(rows: readonly Doc[], id: string | null | undefined, fallback: number): number {
  const i = id ? rows.findIndex((d) => d.id === id) : -1;
  if (i >= 0) return i;
  return Math.min(Math.max(0, fallback), Math.max(0, rows.length - 1));
}

/**
 * Length bands, in Readwise's own minutes. Quick fits a coffee queue; long is
 * the read that wants a sitting. Between them is the ordinary article, which
 * Recent already covers — a third "medium" door would be a door to everything.
 */
export const QUICK_MAX_MIN = 5;
export const LONG_MIN_MIN = 20;

/** Unstarted articles in the library, newest first — the pool the length doors draw on. */
const unstarted = (docs: Doc[]) =>
  docs
    .filter(isArticle)
    .filter((d) => d.location === 'new' || d.location === 'later')
    .filter((d) => d.reading_progress <= HALF_READ_MIN)
    .sort(bySavedDesc);

/** Unknown length is neither quick nor long: guessing would put a book in "quick". */
export function quick(docs: Doc[]): Doc[] {
  return unstarted(docs)
    .filter((d) => { const m = readingMinutes(d); return m !== null && m <= QUICK_MAX_MIN; })
    .slice(0, MAX_ROWS);
}

export function long(docs: Doc[]): Doc[] {
  return unstarted(docs)
    .filter((d) => { const m = readingMinutes(d); return m !== null && m >= LONG_MIN_MIN; })
    .slice(0, MAX_ROWS);
}

/**
 * Articles saved on each of the last `days` local days, oldest first, today
 * last. Drawn from the library already held — the home graph must not fetch.
 */
export function savesByDay(docs: Doc[], now: Date, days = 7): number[] {
  const counts = new Array<number>(days).fill(0);
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  for (const d of docs) {
    if (!isArticle(d)) continue;
    const t = new Date(d.saved_at);
    if (Number.isNaN(t.getTime())) continue;
    const day = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
    // Rounded: a DST change makes one day 23 or 25 hours long.
    const ago = Math.round((midnight - day) / 86_400_000);
    if (ago >= 0 && ago < days) counts[days - 1 - ago]++;
  }
  return counts;
}

export function select(
  key: ViewKey,
  docs: Doc[],
  now: Date,
  rand: () => number = Math.random,
): Doc[] {
  switch (key) {
    case 'recent': return recent(docs);
    case 'today': return today(docs, now);
    case 'halfread': return halfRead(docs);
    case 'surprise': return surprise(docs, rand);
    case 'quick': return quick(docs);
    case 'long': return long(docs);
  }
}

/**
 * A list row: title, publication, reading time.
 *
 * Kept to one line because `ROW.height` is 38px and the firmware line height
 * is a fixed 27 — a second line does not fit and would overprint the row below.
 */
export function rowLabel(d: Doc): string {
  const minutes = readingMinutes(d);
  const meta = [d.site_name, minutes ? `${minutes} min` : null]
    .filter(Boolean)
    .join(' · ');
  return meta ? `${d.title}  —  ${meta}` : d.title;
}

/** Shown when a view is legitimately empty, which is a RESULT, not an error. */
export const EMPTY_MESSAGE: Record<ViewKey, string> = {
  recent: 'No recent articles in New or Later.',
  today: 'Nothing saved today.',
  halfread: 'Nothing in progress. Start something from Recent.',
  surprise: 'Nothing unread in Later.',
  quick: 'No unread articles under 5 minutes.',
  long: 'No unread articles over 20 minutes.',
};
