/**
 * The application core: fetch, cache, and the decisions that need both.
 *
 * Sits between the pure modules (client, views, store, nav) and the two shells
 * (`main.ts` for the glasses, `phone/app.ts` for the webview). It is NOT pure —
 * it does IO — but it takes every dependency as an argument, so it is still
 * fully testable without hardware, a network or a clock.
 *
 * The two rules it exists to enforce:
 *
 *   RATE LIMIT — 20 requests/minute. The library is fetched ONCE and served
 *   from cache thereafter; summaries and article text are cached per article.
 *   Nothing here polls, and nothing asks the Brain for a summary unasked.
 *
 *   NEVER BLANK — every read path falls back to cached data and says how old
 *   it is. A failure must be visible and informative, never an empty screen.
 */

import {
  listAll, fullText, archive,
  explain, type ClientOptions, type Doc,
} from './readwise/client';
import { htmlToText, dropLeadingTitle, excerpt } from './readwise/extract';
import { select, type ViewKey } from './readwise/views';
import {
  saveLibrary, loadLibrary, loadSummary, saveSummary,
  loadPositions, savePosition,
  saveDigest, loadDigest as loadCachedDigest,
  type KV, type Positions,
} from './readwise/store';
import { summarise, type SummaryResult } from './brain/summarise';
import { triage } from './brain/digest';
import type { ClaudeSettings } from './brain/claude';
import { groupByPublication, applyTriage, isFeedReadable, type Digest } from './readwise/digest';

export type AppDeps = {
  readwise: ClientOptions;
  kv: KV;
  now: () => number;
  /** Board base URL for summaries. Injected so tests never touch the tailnet. */
  boardBase?: string;
  fetchImpl?: typeof fetch;
  /**
   * The reader's own Claude key and model, when they have added one. Summaries
   * and Feed triage then call Anthropic directly instead of the Brain board.
   */
  claude?: ClaudeSettings | null;
  rand?: () => number;
};

export type LibraryState = {
  docs: Doc[];
  /** Epoch ms of the fetch that produced these documents. */
  fetchedAt: number;
  /** True when served from cache without a successful network fetch. */
  stale: boolean;
  /** Set when the last fetch failed. Shown to the user verbatim. */
  error: string | null;
};

/**
 * How much of the library we pull.
 *
 * `later` and `new` only — `archive` is 1,364 items nobody is triaging and
 * `feed` is 10,000 and belongs to the phase-2 digest, not here. Three pages
 * each is ~300 documents, which comfortably covers all three views while
 * costing 6 of the 20 requests in a minute.
 */
export const LIBRARY_LOCATIONS = ['new', 'later'] as const;
export const PAGES_PER_LOCATION = 3;

/** Local reading wins for this device; documents without a local position keep Reader's value. */
export function withReadingProgress(docs: Doc[], positions: Positions): Doc[] {
  return docs.map((doc) => {
    const progress = positions[doc.id];
    return typeof progress === 'number' && Number.isFinite(progress) && progress >= 0 && progress <= 1
      ? { ...doc, reading_progress: progress }
      : doc;
  });
}

/**
 * The error a library carries when there is no token to fetch it with. A
 * sentinel rather than prose: the shell shows a first-run screen for it, not
 * the offline one. Sending an empty token got a 401 and greeted a new user
 * with "Offline · Readwise token rejected" (found 2026-10-29).
 */
export const NO_TOKEN = 'no-token';

export type LoadLibraryOptions = {
  /** Skip a fresh cache — the user asked for a refresh. Still one bounded fetch. */
  force?: boolean;
};

/**
 * Load the library, preferring a fresh cache and falling back to a stale one.
 *
 * Order matters and is the whole offline story:
 *   0. No token         → nothing is sent; the cache if there is one, else NO_TOKEN.
 *   1. Fresh cache      → serve it, spend no requests (unless `force`).
 *   2. Network succeeds → serve it, cache it.
 *   3. Network fails    → serve the STALE cache, flagged, with the error.
 *   4. Nothing at all   → surface the error so the shell shows `offline`.
 */
export async function loadLibraryState(deps: AppDeps, options: LoadLibraryOptions = {}): Promise<LibraryState> {
  const now = deps.now();
  const [cached, positions] = await Promise.all([
    loadLibrary(deps.kv, now), loadPositions(deps.kv),
  ]);

  if (!deps.readwise.token) {
    return cached
      ? { docs: withReadingProgress(cached.docs, positions), fetchedAt: cached.fetchedAt, stale: true, error: NO_TOKEN }
      : { docs: [], fetchedAt: 0, stale: true, error: NO_TOKEN };
  }

  if (cached?.fresh && !options.force) {
    return { docs: withReadingProgress(cached.docs, positions), fetchedAt: cached.fetchedAt, stale: false, error: null };
  }

  try {
    const pages = await Promise.all(
      LIBRARY_LOCATIONS.map((location) =>
        listAll(deps.readwise, { location, category: 'article' }, PAGES_PER_LOCATION)),
    );
    // Readwise can return the same document under more than one query; dedupe
    // by id so a row cannot appear twice in a list.
    const byId = new Map<string, Doc>();
    for (const d of pages.flat()) byId.set(d.id, d);
    const docs = [...byId.values()];

    await saveLibrary(deps.kv, docs, now);
    return { docs: withReadingProgress(docs, positions), fetchedAt: now, stale: false, error: null };
  } catch (e) {
    const error = explain(e);
    if (cached) {
      return { docs: withReadingProgress(cached.docs, positions), fetchedAt: cached.fetchedAt, stale: true, error };
    }
    return { docs: [], fetchedAt: 0, stale: true, error };
  }
}

/** The documents for a view, from an already-loaded library. */
export const rowsFor = (state: LibraryState, view: ViewKey, deps: AppDeps): Doc[] =>
  select(view, state.docs, new Date(deps.now()), deps.rand);

/**
 * Where to reopen an article, 0..1.
 *
 * Two sources can know: `local` is what THIS app stored as the reader turned
 * sheets (undefined if it never has, and 1 once the reader swiped past the
 * end), and `remote` is Readwise's `reading_progress` — written only by
 * Reader's own apps (web, phone). This app cannot write it: the API accepts
 * the PATCH and changes nothing (verified 2026-09-24), so `remote` never
 * reflects reading done on the glasses.
 */
export function resumeAt(local: number | undefined, remote: number): number {
  // TODO(Anton): the resume policy. Until then only this app's own positions
  // are used, so an article started on the phone or the web opens at the top,
  // and one finished here (local = 1) reopens on its last sheet.
  void remote;
  return local ?? 0;
}

/**
 * The article's text, and everything local about it: a cached summary and
 * where it was left.
 *
 * Split from the summary because the two arrive on very different clocks. The
 * text is one Readwise request; an uncached summary is a full Claude turn that
 * can take a minute. Waiting for both held the reader hostage to the slower
 * one — the full article was already in memory and could not be opened.
 */
export type ArticleText = {
  id: string;
  /** Plaintext, extracted from html_content. Empty when it could not be read. */
  text: string;
  /** A Brain summary from an earlier visit. Articles do not change, so neither does this. */
  cachedSummary: string | null;
  /** Where to reopen the reader, 0..1. */
  resume: number;
  error: string | null;
};

export async function loadArticleText(deps: AppDeps, doc: Doc): Promise<ArticleText> {
  const positions = await loadPositions(deps.kv);
  const resume = resumeAt(positions[doc.id], doc.reading_progress);
  const cachedSummary = await loadSummary(deps.kv, doc.id);

  let text = '';
  let error: string | null = null;
  try {
    text = dropLeadingTitle(doc.title, htmlToText(await fullText(deps.readwise, doc.id)));
  } catch (e) {
    error = explain(e);
  }
  return { id: doc.id, text, cachedSummary, resume, error };
}

/**
 * Ask the Brain for a summary of text already loaded. Never throws — see
 * `summarise` — and caches only a real Brain summary: an extract is a fallback
 * for a transient failure, and caching it would make the outage permanent.
 */
export async function summariseArticle(
  deps: AppDeps,
  doc: Doc,
  text: string,
): Promise<SummaryResult> {
  const s = await summarise(doc.title, doc.author, text, {
    base: deps.boardBase,
    fetchImpl: deps.fetchImpl,
    claude: deps.claude,
  });
  if (s.fromBrain) await saveSummary(deps.kv, doc.id, s.text);
  return s;
}

/**
 * What an article's front page shows before anyone has asked for a summary.
 *
 * Summaries used to be requested on EVERY open — and on the next article after
 * every archive. Each one is a full Claude turn on the mini (the board runs it
 * as its own `claude --print` session), so swiping through a list started a
 * session per row, most of them for articles never read past the title
 * (reported 2026-11-19). A summary is now asked for, never assumed; this is
 * what stands in for one, and it costs nothing.
 *
 * The publisher's blurb comes first: it is already in the library, so it shows
 * before the text has arrived. It is labelled as the publisher's — Readwise's
 * `summary` field is not an AI summary (see `readwise/client.ts`). Otherwise
 * the opening of the article, which is where a piece states its thesis.
 */
export type Preview = { text: string; source: 'publisher' | 'opening' };

/** Long enough to carry a thesis, short enough that Read is the way on. */
export const PREVIEW_CHARS = 600;

export function articlePreview(doc: Pick<Doc, 'summary'>, text: string): Preview | null {
  const blurb = doc.summary?.trim();
  if (blurb) return { text: excerpt(blurb, PREVIEW_CHARS), source: 'publisher' };
  const opening = text.trim();
  return opening ? { text: excerpt(opening, PREVIEW_CHARS), source: 'opening' } : null;
}

/**
 * Record how far through an article the reader is — locally, and only locally.
 *
 * This used to PATCH `reading_progress` to Readwise on every page turn as
 * well. Readwise answers that PATCH with 200 and ignores it (verified against
 * the live API, 2026-09-24): the field is not writable. Every one of those
 * writes spent a request from the 50/min update budget to change nothing, and
 * the code claimed a sync with the phone that never happened. The local
 * position is what resume runs on, so it is the one that is kept.
 */
export async function recordProgress(
  deps: AppDeps,
  id: string,
  progress: number,
): Promise<void> {
  await savePosition(deps.kv, id, progress);
}

/**
 * Archive an article remotely, then commit the same change locally.
 *
 * Readwise success is the commit boundary. Removing first made a failed PATCH
 * look successful until the next sync resurrected the row. Returning the
 * updated document list rather than refetching is still deliberate: a library
 * refetch costs up to six requests and cannot make the confirmed write truer.
 */
/**
 * The library an archive applies to — a value, or a getter read AFTER Readwise
 * has answered. The glasses pass a getter: a refresh can land while the PATCH
 * is in flight, and filtering the snapshot captured before it would write
 * that older library back over the fresh one (review of PR #1, 2026-10-29).
 */
export type LibrarySource = LibraryState | (() => LibraryState);
const current = (source: LibrarySource): LibraryState =>
  typeof source === 'function' ? source() : source;

/** The remote half of an archive: Readwise's answer, and nothing local. */
export async function archiveRemote(
  deps: AppDeps,
  id: string,
): Promise<{ archived: boolean; error: string | null }> {
  try {
    const updated = await archive(deps.readwise, id);
    // Reader can redirect an unsupported location to the user's default. When
    // the response includes the location, do not call that an archive unless
    // it is one. Older/minimal responses omit the field; HTTP 200 remains their
    // documented success boundary.
    if (updated?.location && updated.location !== 'archive') {
      return { archived: false, error: 'Readwise did not move this article to Archive.' };
    }
    return { archived: true, error: null };
  } catch (e) {
    return { archived: false, error: explain(e) };
  }
}

/** The local half: the library without the article. Pure. */
export const withoutDoc = (state: LibraryState, id: string): LibraryState =>
  state.docs.some((d) => d.id === id)
    ? { ...state, docs: state.docs.filter((d) => d.id !== id) }
    : state;

/**
 * Put an article back after a failed archive, from the latest snapshot that
 * still has it — a refresh that landed while the PATCH was in flight may have
 * been pruned of it. Keeps the snapshot's order. Pure.
 */
export function restoreDoc(state: LibraryState, snapshot: LibraryState | null, id: string): LibraryState {
  if (state.docs.some((d) => d.id === id)) return state;
  const doc = snapshot?.docs.find((d) => d.id === id);
  if (!doc) return state;
  const have = new Set(state.docs.map((d) => d.id));
  // Insert where the snapshot has it, relative to the documents both hold.
  const docs = [...state.docs];
  const after = snapshot!.docs.slice(0, snapshot!.docs.indexOf(doc)).filter((d) => have.has(d.id)).pop();
  const at = after ? docs.findIndex((d) => d.id === after.id) + 1 : 0;
  docs.splice(at, 0, doc);
  return { ...state, docs };
}

/**
 * The one place the library changes.
 *
 * Two archives in flight at once both read the library, both removed their
 * own article, and the later write put the earlier article back — in memory
 * and in the cache (review of PR #1, round 2). Every mutation goes through
 * this chain: read the latest state, update, publish it SYNCHRONOUSLY, and
 * only then persist. The shell owns the variable; this owns the ordering.
 */
export type LibraryIO = {
  read: () => LibraryState | null;
  write: (state: LibraryState) => void;
  persist: (state: LibraryState) => Promise<void>;
};

/** Whether a committed state goes to the cache: a flag, or decided from the state itself. */
export type Persist = boolean | ((next: LibraryState) => boolean);

export type LibraryStore = {
  /**
   * Apply `update` to the latest library, on the chain. Anything `update`
   * reads or changes besides the library (the confirmed-archive set) is read
   * and changed at commit time, so no caller may touch that state off-chain.
   * `persist` false for a state already cached (a fetch).
   */
  commit(update: (state: LibraryState | null) => LibraryState, persist?: Persist): Promise<LibraryState>;
};

export function libraryStore(io: LibraryIO): LibraryStore {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    commit(update, persist = true) {
      const run = chain.then(async () => {
        const before = io.read();
        const next = update(before);
        io.write(next);
        const save = typeof persist === 'function' ? persist(next) : persist;
        if (save && next !== before) await io.persist(next);
        return next;
      });
      chain = run.catch(() => {});
      return run;
    },
  };
}

/** Persist a library the way a fetch does — the cache the offline story boots from. */
export const persistLibrary = (deps: AppDeps, state: LibraryState): Promise<void> =>
  saveLibrary(deps.kv, state.docs, state.fetchedAt);

/**
 * Archive remotely, then commit the same change locally — for a caller with
 * one archive in flight at a time (the phone). The glasses use `archiveRemote`
 * and commit through their `libraryStore`, which serialises concurrent writes.
 */
export async function archiveArticle(
  deps: AppDeps,
  source: LibrarySource,
  id: string,
): Promise<{ state: LibraryState; archived: boolean; error: string | null }> {
  const r = await archiveRemote(deps, id);
  if (!r.archived) return { state: current(source), ...r };
  const next = withoutDoc(current(source), id);
  // Update the cache only after Readwise accepted the mutation, or reopening
  // the app can preserve a local state that never existed remotely.
  await persistLibrary(deps, next);
  return { state: next, archived: true, error: null };
}

/**
 * Drop articles archived this session from a freshly fetched library. Pure,
 * so it can run INSIDE a `libraryStore` commit and read the confirmed set at
 * commit time — a refresh that snapshotted the set and persisted off-chain
 * could forget an archive confirmed meanwhile and publish the article back
 * (review of PR #1, round 3).
 *
 * A refresh that started before an archive's PATCH landed can bring the
 * archived article back — in memory, and in the cache `loadLibraryState` has
 * just written. `pruned` names the ids that were actually present, so the
 * caller can tell a snapshot that was stale for an id from one where Readwise
 * has already caught up (and stop remembering that id).
 */
export function pruneArchived(
  state: LibraryState,
  archivedIds: Iterable<string>,
): { state: LibraryState; pruned: string[] } {
  const ids = new Set(archivedIds);
  const pruned = state.docs.filter((d) => ids.has(d.id)).map((d) => d.id);
  if (pruned.length === 0) return { state, pruned };
  return { state: { ...state, docs: state.docs.filter((d) => !ids.has(d.id)) }, pruned };
}

/** Re-save only what a fetch wrote: a stale or empty library was never cached. */
export const wasFetched = (state: LibraryState): boolean => !state.stale && state.fetchedAt > 0;

/**
 * Archives confirmed this session, each stamped with WHEN on a shared clock
 * that refreshes also tick. A refresh takes a ticket before it fetches; when
 * its snapshot commits, a marker is forgotten only if the snapshot did not
 * contain the article AND the fetch started after the confirmation — a
 * snapshot fetched before it cannot know, and must not clear it (review of
 * PR #1, round 4). Markers are read and changed only inside library commits.
 */
export type ArchiveMarkers = {
  /** A refresh is about to fetch: its ticket. */
  tick(): number;
  confirm(id: string): void;
  ids(): string[];
  /** After the snapshot from the fetch ticketed `startedAt` was pruned of `pruned`. */
  settle(startedAt: number, pruned: readonly string[]): void;
  has(id: string): boolean;
};

export function archiveMarkers(): ArchiveMarkers {
  let clock = 0;
  const marks = new Map<string, number>();
  return {
    tick: () => ++clock,
    confirm: (id) => { marks.set(id, ++clock); },
    ids: () => [...marks.keys()],
    settle(startedAt, pruned) {
      for (const [id, at] of marks) {
        if (at < startedAt && !pruned.includes(id)) marks.delete(id);
      }
    },
    has: (id) => marks.has(id),
  };
}

/**
 * One in flight at a time: a call made while the previous is running joins it
 * and gets the same promise, rather than starting a second. Two overlapping
 * refreshes let the newer finish first, forget an archive's marker, and then
 * the older snapshot brought the article back (review of PR #1, round 4).
 * Single-flight end to end is the simple way to make that impossible.
 */
export function singleFlight<A extends unknown[], T>(fn: (...args: A) => Promise<T>): (...args: A) => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return (...args) => {
    if (inFlight) return inFlight;
    inFlight = fn(...args).finally(() => { inFlight = null; });
    return inFlight;
  };
}

// -------------------------------------------------------------------- digest

/**
 * How much feed to pull for the digest.
 *
 * Two pages is ~200 of the most recent items — enough that a day's intake is
 * represented, cheap enough to sit alongside the library's six requests inside
 * a 20/min budget. The feed holds 10,000 items and is never fetched whole; the
 * digest is explicitly about what arrived RECENTLY.
 */
export const DIGEST_PAGES = 2;

export type DigestState = Digest & {
  /** Epoch ms the triage was built. 0 when it is grouping alone. */
  builtAt: number;
  error: string | null;
};

/**
 * Build the feed digest: fetch, then triage, then fall back.
 *
 * The order is chosen around cost. The feed fetch is cheap and always needed —
 * grouping alone is a usable digest. Triage is a full Claude turn over a
 * hundred titles, so a cached one is reused for hours and a failed one costs
 * nothing beyond the wait.
 *
 * Never throws. Every failure degrades to a smaller true thing: no triage means
 * grouping by publication, no feed means the cached picks against nothing, and
 * both means an empty digest with the error attached.
 */
export type LoadDigestOptions = {
  /** Explicit mutations may require new picks rather than the cached triage. */
  forceTriage?: boolean;
  /** Hide a just-archived ID even if Reader indexing is briefly stale. */
  excludeIds?: readonly string[];
};

export async function loadDigest(
  deps: AppDeps,
  options: LoadDigestOptions = {},
): Promise<DigestState> {
  const now = deps.now();
  const when = new Date(now);

  let docs: Doc[] = [];
  let error: string | null = null;
  try {
    // Do not ask Readwise for category=article here. Real Feed entries are
    // commonly category=rss or category=email; the old filter made a populated
    // hardware Feed look empty. `groupByPublication` keeps only the readable
    // article/RSS/email formats after fetching the bounded recent slice.
    const excluded = new Set(options.excludeIds ?? []);
    docs = (await listAll(deps.readwise, { location: 'feed' }, DIGEST_PAGES))
      .filter(isFeedReadable)
      .filter((doc) => !excluded.has(doc.id));
  } catch (e) {
    error = explain(e);
  }

  const grouped = groupByPublication(docs, when);
  const fallback = (err: string | null): DigestState => ({
    sections: grouped, fromBrain: false, considered: docs.length, builtAt: 0, error: err,
  });

  if (docs.length === 0) return fallback(error);

  // A cached triage is checked before the board is called at all — it is the
  // most expensive call in the app and the feed does not turn over that fast.
  const cached = await loadCachedDigest(deps.kv, now);
  if (!options.forceTriage && cached?.fresh) {
    const sections = applyTriage(docs, cached.picks);
    // Picks that resolve to nothing mean the feed has moved on entirely; the
    // grouping is then more useful than an empty screen.
    if (sections.length > 0) {
      return { sections, fromBrain: true, considered: docs.length, builtAt: cached.builtAt, error };
    }
  }

  const picks = await triage(docs, {
    base: deps.boardBase, fetchImpl: deps.fetchImpl, claude: deps.claude,
  });
  if (!picks) {
    // The board is unreachable or wrote something unparseable. A stale cached
    // triage is still better than plain grouping — it named real articles.
    if (!options.forceTriage && cached) {
      const sections = applyTriage(docs, cached.picks);
      if (sections.length > 0) {
        return { sections, fromBrain: true, considered: docs.length, builtAt: cached.builtAt, error };
      }
    }
    return fallback(error);
  }

  const sections = applyTriage(docs, picks);
  if (sections.length === 0) return fallback(error);
  await saveDigest(deps.kv, picks, now);
  return { sections, fromBrain: true, considered: docs.length, builtAt: now, error };
}

/** "Last synced" for the offline banner. Local time — it is read by a human. */
export function syncedAt(fetchedAt: number): string | null {
  if (!fetchedAt) return null;
  const d = new Date(fetchedAt);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
