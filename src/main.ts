/**
 * Readwise on Even Realities G2.
 *
 * Wiring only — the ONLY file that touches the SDK. Every decision lives in
 * pure modules:
 *   readwise/client.ts — the Reader API
 *   readwise/views.ts  — the three ways in
 *   glass/layout.ts    — container primitives + budget validation
 *   glass/sheets.ts    — long text → sheets the firmware scrolls
 *   glass/screens.ts   — every screen, as data
 *   glass/nav.ts       — five gestures → route + effect
 *   app.ts             — fetch, cache and the offline story
 *
 * That split is what lets the whole HUD be tested with no hardware.
 */

import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  MenuContainerProperty,
  MenuItemProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  AudioInputSource,
} from '@evenrealities/even_hub_sdk';

import { mountPhone } from './phone/app';
import { readToken, useHostStore, hydrate } from './readwise/token';
import { readClaude, hydrateClaude } from './brain/settings';
import { boardEnabled } from './brain/summarise';
import { localStorageOnly, withHost, type AppStorage } from './readwise/storage';
import {
  select, savesByDay, isArticle, reconcileRows, HALF_READ_MIN, HALF_READ_MAX, type ViewKey,
} from './readwise/views';
import { readingMinutes, type Doc } from './readwise/client';
import {
  transcribe, searchLibrary, askLibrary, queueFrom, docFromHit, type LibrarySearch,
} from './brain/library';
import { utterance, endpointer, BYTES_PER_SECOND, type Utterance, type Endpointer } from './voice/utterance';
import { isQuestion, isCurrent, MIN_UTTERANCE_BYTES } from './voice/ask';
import {
  loadLibraryState, loadArticleText, summariseArticle, articlePreview, recordProgress,
  archiveRemote, withoutDoc, restoreDoc, libraryStore, persistLibrary,
  pruneArchived, wasFetched, archiveMarkers, singleFlight,
  syncedAt, loadDigest as loadFeedDigest, NO_TOKEN, withReadingProgress,
  type AppDeps, type LibraryState, type DigestState,
} from './app';
import * as S from './glass/screens';
import {
  step, destinationForGesture, nextAfter, repointFocus,
  type Route, type Effect, type NavContext, type Gesture, type Destination, type AskPhase,
} from './glass/nav';
import { gestureFrom, acceptHold, lifecycleFrom } from './main-gestures';
import { diffScreens } from './glass/diff';
import { settleWithin, accepted } from './settle';
import type { Screen, TextSpec } from './glass/layout';

// ------------------------------------------------------------------- state

let library: LibraryState | null = null;
let route: Route = { name: 'home', focus: 0 };
let started = false;

/**
 * Archives CONFIRMED this session, so a refresh cannot bring one back. A
 * refresh runs off the input queue and replaces `library` wholesale: a
 * snapshot fetched before an archive's PATCH landed still holds the article,
 * in memory and in the cache the fetch wrote. An id is forgotten once
 * Readwise stops returning the article, so one un-archived on the phone comes
 * back on the refresh after that. Archives still in flight are NOT excluded:
 * if the PATCH then fails the article must still be there (review of PR #1,
 * round 2) — see `restoreDoc`. Read and changed ONLY inside `libraryWrites`
 * commits, so a refresh cannot forget an archive confirmed while it was
 * persisting (round 3); stamped against the refresh clock, so a snapshot
 * fetched before a confirmation cannot clear its marker (round 4).
 */
const archived = archiveMarkers();

/** The last snapshot a fetch produced, before any pruning — what a failed archive restores from. */
let lastFetched: LibraryState | null = null;

/**
 * Every change to `library` goes through this chain, so two archives in
 * flight at once (hold, hold) cannot each remove their own article from the
 * same starting state and let the later write bring the earlier one back.
 */
// Overlay positions made during this session at commit time, so a refresh
// begun before the latest sheet turn cannot roll Continue back to an old value.
const sessionProgress: Record<string, number> = {};
const libraryWrites = libraryStore({
  read: () => library,
  write: (s) => { library = { ...s, docs: withReadingProgress(s.docs, sessionProgress) }; },
  persist: (s) => persistLibrary(deps(), s),
});

type ArticleRoute = Extract<Route, { name: 'summary' | 'reader' }>;

/**
 * An article being read, as far as it has arrived.
 *
 * Text and summary land separately. The text is one Readwise request; an
 * uncached summary is a Claude turn that can take a minute — and the reader
 * must not wait for the summary when the article it wants is already here.
 */
type Article = {
  doc: Doc;
  /** Plaintext; empty when it could not be read. */
  text: string;
  error: string | null;
  /**
   * The Brain's summary, or null when none has been asked for. Opening an
   * article does not ask: each summary is a Claude session on the mini, and
   * asking on every open started one per row swiped through (2026-11-19).
   */
  summary: string | null;
  /** Asked for and not back yet. */
  summarising: boolean;
  /** Where to reopen the reader, 0..1. Kept current as sheets turn. */
  resume: number;
  /** Progress 1 was already written this session — a swipe past the end can repeat. */
  finished: boolean;
};

/**
 * Articles held in memory, keyed by ID. A map rather than one slot: with one,
 * a slow fetch for the article the user just left overwrote the one they moved
 * to, and every screen had to guard against it. A few are kept so going back
 * to a list and into the same article again costs no request.
 */
const articles = new Map<string, Article>();
const ARTICLES_KEPT = 6;
/** Loads in flight, so a second press joins the first instead of re-requesting. */
const opening = new Map<string, Promise<void>>();

/**
 * Storage. Starts webview-only and is replaced with the host-backed store once
 * the bridge exists — nothing reads it before then, but the fallback keeps this
 * total rather than leaving a null to guard on every access.
 */
let storage: AppStorage = localStorageOnly();

const deps = (): AppDeps => ({
  readwise: { token: readToken() },
  claude: readClaude(),
  kv: storage.kv,
  now: () => Date.now(),
});

/**
 * Every bridge call is serialised through this. The SDK docs are explicit that
 * concurrent render/storage calls can crash the connection, and an overlapping
 * rebuild is very hard to diagnose on-device.
 */
let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
};

/** A single flaky BLE hop can hang ~30s, so cap every call. */
const withTimeout = <T>(p: Promise<T>, ms = 5000): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) =>
    setTimeout(() => rej(new Error('bridge timeout')), ms))]);

/**
 * Deadline for a render call. Past it the result is not trusted and a rebuild
 * follows — but only once the call has settled, so the rebuild never overlaps
 * it on the bridge. There is deliberately NO hard cap: a render call that
 * never settles keeps the serial queue waiting, which is what `serial()`
 * means. Giving up and rebuilding over a pending upgrade let the late upgrade
 * overwrite the rebuilt screen (review of PR #1, round 6).
 */
const RENDER_SOFT_MS = 5000;

// The phone companion mounts FIRST and independently of the bridge: the webview
// is useful on its own, and waiting on the glasses would leave the phone blank
// whenever they are not connected.
const phoneRoot = document.querySelector<HTMLElement>('#app');
const phone = phoneRoot ? mountPhone(phoneRoot) : null;

const bridge = await waitForEvenAppBridge();

/**
 * `waitForEvenAppBridge` resolves as soon as the bridge object exists, which is
 * slightly before the display is ready to accept a page — creating immediately
 * returns code 1 (invalid parameters). A short settle removes the race; the
 * retry in `draw` covers the case where it is still not ready.
 */
await new Promise((r) => setTimeout(r, 300));

/**
 * Move the token onto the HOST store now that the bridge exists.
 *
 * The webview's own `localStorage` does not survive the Even Hub app closing,
 * so a token kept only there was gone by the next launch and the app asked for
 * it every time. `bridge.get/setLocalStorage` persists through the host app.
 *
 * The methods are passed as bound functions rather than the bridge itself, so
 * `readwise/token.ts` and `readwise/store.ts` stay free of any SDK import and
 * remain unit-testable — the invariant this whole codebase rests on.
 *
 * Hydrating here also covers the phone: it mounted before the bridge existed
 * and hydrated off the mirror, and this second pass repaints it with the
 * durable value if the two ever disagree.
 */
const host = {
  get: (key: string) => serial(() => withTimeout(bridge.getLocalStorage(key))),
  set: (key: string, value: string) => serial(() => withTimeout(bridge.setLocalStorage(key, value))),
};
useHostStore(host);
// The Claude settings ride the same store; read at once so the first article
// opened knows whether a summary can be offered.
await Promise.all([hydrate(), hydrateClaude()]);

// The library cache and reading positions move onto the host store for the same
// reason as the token: kept in the webview they were cleared when the app
// closed, so the offline story ("backend killed → boots to the cached library")
// could not actually hold and resume forgot the page. Positions are debounced
// inside `withHost` — they are written on every sheet turn, and a bridge hop per
// turn would make reading feel laggy.
storage = withHost(host);
// The phone mounted before the bridge existed, on webview storage. Hand it the
// durable one so both surfaces read the same cache.
phone?.useStorage(storage);

// ------------------------------------------------------------------ render

const toProperty = (c: TextSpec) =>
  new TextContainerProperty({
    xPosition: c.xPosition,
    yPosition: c.yPosition,
    width: c.width,
    height: c.height,
    borderWidth: c.borderWidth,
    borderColor: c.borderColor,
    borderRadius: c.borderRadius,
    paddingLength: c.paddingLength,
    containerID: c.containerID,
    containerName: c.containerName,
    content: c.content,
    isEventCapture: c.isEventCapture,
    textColor: c.textColor,
  });

/** The screen last accepted by the glasses. Null when unknown. */
let drawn: Screen | null = null;

/**
 * Draw a screen.
 *
 * `createStartUpPageContainer` runs exactly once. After that `diffScreens`
 * decides: a screen identical to the one up is NOT redrawn — that used to be
 * a wasted flicker, and on a reading sheet it is a lost place, since the
 * firmware scrolls the sheet itself and a rebuild snaps it back to the top.
 * A screen that differs only in content or brightness — a focus move, a
 * notice, a summary arriving — is upgraded in place, container by container,
 * flicker-free. Anything else is a rebuild. An upgrade the glasses refuse or
 * that times out falls back to a rebuild, so the worst case is what every
 * render used to be.
 */
async function draw(s: Screen): Promise<void> {
  const textObject = s.containers.map(toProperty);
  const menuObject = s.menuItems?.length
    ? new MenuContainerProperty({ menuItems: s.menuItems.map((item) => new MenuItemProperty(item)) })
    : undefined;
  await serial(async () => {
    if (!started) {
      const code = await withTimeout(
        bridge.createStartUpPageContainer(
          new CreateStartUpPageContainer({ containerTotalNum: textObject.length, textObject, menuObject }),
        ),
      );
      // Only claim we started if the page actually got created. Setting the
      // flag optimistically leaves every later render rebuilding a page that
      // does not exist — silent, and permanent.
      if (code === 0) {
        started = true;
        drawn = s;
      } else {
        const why = { 1: 'invalid parameters', 2: 'content too large', 3: 'out of memory' }[code as number] ?? 'unknown';
        console.error(`[readwise] startup page failed (code ${code}: ${why}) — will retry on next render`);
      }
      return;
    }
    // Decided inside the queue: the screen up is whatever the LAST queued
    // draw left, not whatever was up when this one was requested.
    const diff = diffScreens(drawn, s);
    // One line per draw in the Even Hub console: which path a render took.
    console.debug(`[readwise] draw ${s.name}: ${diff.kind}${diff.kind === 'upgrade' ? ` ×${diff.changed.length}` : ''}`);
    if (diff.kind === 'same') return;
    // Unknown until the glasses answer: a timeout mid-call leaves the screen
    // in a state nothing here can see, so the next draw must not skip.
    drawn = null;
    if (diff.kind === 'upgrade' && await upgrade(diff.changed)) {
      drawn = s;
      return;
    }
    const r = await settleWithin(
      bridge.rebuildPageContainer(
        new RebuildPageContainer({ containerTotalNum: textObject.length, textObject, menuObject }),
      ),
      RENDER_SOFT_MS,
    );
    // A late rebuild leaves `drawn` null, so the next render redraws whatever
    // the route is by then over whatever the late call left on screen.
    if (accepted(r)) drawn = s;
    else console.error(`[readwise] rebuild of "${s.name}": ${r.kind}`);
  });
}

/**
 * Upgrade containers in place. False — and a rebuild follows — if any call is
 * refused, rejects, or misses its deadline; a half-applied upgrade is then
 * overwritten whole. Called inside `serial`, one container at a time: bridge
 * calls must not overlap, which is why a slow call is WAITED OUT — however
 * long — before the rebuild runs (`settleWithin`), never raced and left
 * behind for a late result to overwrite the rebuilt screen.
 */
async function upgrade(changed: TextSpec[]): Promise<boolean> {
  for (const c of changed) {
    const r = await settleWithin(bridge.textContainerUpgrade(new TextContainerUpgrade({
      containerID: c.containerID,
      containerName: c.containerName,
      // Whole-content replacement (glasses-ui skill: offset 0, length 0).
      contentOffset: 0,
      contentLength: 0,
      content: c.content,
      textColor: c.textColor,
    })), RENDER_SOFT_MS);
    if (accepted(r)) continue;
    console.error(`[readwise] upgrade of "${c.containerName}": ${r.kind}${r.kind === 'value' ? ' false' : ''} — rebuilding`);
    return false;
  }
  return true;
}

/**
 * The rows currently on screen.
 *
 * This is STATE, not a computed value, and that is load-bearing. `select()` for
 * the Surprise view runs a shuffle, so recomputing it per render returned a
 * different order every time: the focus cursor pointed into a list that no
 * longer existed, and pressing opened an article the user had not selected.
 * The list is drawn once when a view is entered and then held.
 */
let rows: Doc[] = [];

/**
 * The feed digest, once loaded. Held like `rows` and for the same reason: it is
 * the result of a fetch plus a model turn, and recomputing it per render would
 * be both wrong and ruinously expensive.
 */
let feedDigest: DigestState | null = null;
let digestLoading = false;
/**
 * Feed articles archived since the digest was triaged. Each leaves a gap in the
 * picks; they are refilled — once, for all of them — the next time the digest
 * is on screen, and kept out of the refill in case Reader has not yet indexed
 * the move.
 */
let feedArchived: string[] = [];
/** One-action feedback; cleared as soon as the user does something else. */
let operationNotice: string | null = null;
/** When the last hold was accepted — see `acceptHold`. */
let lastHoldAt = 0;

/**
 * The question being asked, as far as it has got. `seq` ties each async step
 * to the question that started it: cancelling or asking again bumps `askSeq`,
 * and a result carrying an older one is dropped rather than painted over the
 * screen the user moved to.
 */
type Question = {
  seq: number;
  heard: string;
  /** Documents the search turned up — shown while the answer is being written. */
  found: number;
  answer: string;
  picks: S.AnswerPick[];
  error: string | null;
};
let question: Question | null = null;
let askSeq = 0;
/** The open microphone, only while a question is being spoken. */
let mic: { seq: number; speech: Utterance; ends: Endpointer; sending: boolean } | null = null;

/** Enter a view: draw its list once, and hold it until the view is left. */
function enterView(view: ViewKey): void {
  rows = library ? select(view, library.docs, new Date()) : [];
}

/**
 * Re-derive the current list after the library itself changes (an archive).
 * Filters the held rows rather than re-selecting, so a Surprise draw survives.
 */
function pruneRows(): void {
  const ids = new Set(library?.docs.map((d) => d.id) ?? []);
  rows = rows.filter((d) => ids.has(d.id));
}

/**
 * Drop an archived article from the digest.
 *
 * Sections that empty are removed with it — an empty section is a row that
 * opens onto nothing. The digest is NOT rebuilt here: that costs another feed
 * fetch and model turn, and happens only when the digest is next looked at.
 */
function pruneDigest(id: string): void {
  if (!feedDigest) return;
  const sections = feedDigest.sections
    .map((s) => ({ ...s, docs: s.docs.filter((d) => d.id !== id) }))
    .filter((s) => s.docs.length > 0);
  feedDigest = { ...feedDigest, sections };
}

/**
 * Find an article by ID, in the library OR the digest.
 *
 * The digest is fetched from `feed`, which `loadLibraryState` deliberately does
 * not pull — so searching only the library meant every feed article resolved to
 * nothing, and pressing one bounced back to home. Both sources are searched
 * because both put rows on screen.
 */
const findDoc = (id: string): Doc | undefined =>
  library?.docs.find((d) => d.id === id)
  ?? feedDigest?.sections.flatMap((s) => s.docs).find((d) => d.id === id)
  // An answer can point at a document in neither — an archived one.
  ?? question?.picks.find((p) => p.doc.id === id)?.doc
  // An article being read survives a refresh that no longer lists it: the
  // reader must not be thrown to Home mid-sheet because the phone archived it.
  ?? articles.get(id)?.doc;

/** The section an article belongs to, for the menu; none when an answer opened it. */
const articleSection = (r: ArticleRoute): Destination | null =>
  r.origin?.kind === 'section' ? 'digest' : r.origin?.kind === 'answers' ? null : r.view;

/** The list an article was opened from — where "next" comes from. */
const originDocs = (r: ArticleRoute): Doc[] =>
  r.origin?.kind === 'section' ? feedDigest?.sections[r.origin.section]?.docs ?? []
    : r.origin?.kind === 'answers' ? question?.picks.map((p) => p.doc) ?? []
      : rows;

const hasNext = (r: ArticleRoute): boolean => nextAfter(originDocs(r), r.id) !== null;

/** Hold an article, evicting the least recently opened beyond a few. */
function remember(id: string, a: Article): void {
  articles.delete(id);
  articles.set(id, a);
  for (const old of articles.keys()) {
    if (articles.size <= ARTICLES_KEPT) break;
    articles.delete(old);
  }
}

/** The reader sheet an article reopens at — where it was left. */
function resumeSheet(id: string): number {
  const a = articles.get(id);
  if (!a?.text) return 0;
  return S.sheetForProgress(S.readerSheets(a.doc, a.text), a.resume, a.text.length);
}

/** Home is computed only from already-held state: rendering it never fetches. */
function homeOverview(): S.HomeOverview {
  const docs = library?.docs ?? [];
  const now = new Date();
  const feed: S.HomeOverview['feed'] = digestLoading
    ? 'loading'
    : !feedDigest
      ? 'not-opened'
      : feedDigest.error
        ? 'error'
        : {
            groups: feedDigest.sections.length,
            articles: new Set(
              feedDigest.sections.flatMap((section) => section.docs.map((doc) => doc.id)),
            ).size,
          };
  const unread = docs.filter((doc) =>
    isArticle(doc)
    && (doc.location === 'new' || doc.location === 'later')
    && doc.reading_progress <= HALF_READ_MIN);
  const keys: ViewKey[] = ['recent', 'today', 'halfread', 'surprise', 'quick', 'long'];
  // The same selectors the doors open with, so a count can never promise a
  // list the door then fails to show. Surprise shuffles, but only its length
  // is kept here, so the draw is not consumed.
  const counts = Object.fromEntries(
    keys.map((k) => [k, select(k, docs, now).length]),
  ) as Record<ViewKey, number>;
  return {
    week: savesByDay(docs, now),
    queued: unread.length,
    queueMinutes: unread.reduce((sum, doc) => sum + (readingMinutes(doc) ?? 0), 0),
    inProgress: docs.filter((doc) =>
      doc.reading_progress > HALF_READ_MIN && doc.reading_progress < HALF_READ_MAX).length,
    syncedAt: syncedAt(library?.fetchedAt ?? 0),
    stale: Boolean(library?.stale),
    feed,
    counts,
  };
}

/**
 * What the summary screen shows for an article, as `S.summary` arguments.
 * One function for the render AND for `navContext`, so the reducer counts
 * exactly the sheets that are drawn.
 */
function summaryArgs(
  a: Article | undefined,
  d: Doc,
): [text: string, fromBrain: boolean, status: boolean, gist: S.GistOptions] {
  if (a?.summary) return [a.summary, true, false, {}];
  // The publisher's blurb is in the library already, so it shows before the
  // text has arrived; Summarise waits for the text (`summariseOpen`).
  const p = articlePreview(d, a?.text ?? '');
  if (!p) {
    if (!a) return ['Loading…', true, true, {}];
    // Nothing to show and nothing cached: the failure IS the result, and
    // saying so beats "Loading…" forever on an article that will never arrive.
    return [a.error ?? 'No readable text for this article.', false, true, {}];
  }
  // Offered until the text is known to be missing (there is nothing to send),
  // and only when something can write it: the reader's Claude key, or a build
  // that reaches the Brain board.
  const claude = readClaude();
  const offer = (!a || Boolean(a.text)) && (claude !== null || boardEnabled());
  return [p.text, false, false, {
    preview: p.source, summarising: a?.summarising, offer, ai: claude ? 'Claude' : 'Brain',
  }];
}

function currentScreen(): Screen {
  if (!library) return S.loading();

  // No token and nothing cached: first run, not an outage.
  if (library.docs.length === 0 && library.error === NO_TOKEN) return S.welcome();

  // No library AND an error means there is nothing to show but the error.
  if (library.docs.length === 0 && library.error) {
    return S.offline(library.error, syncedAt(library.fetchedAt));
  }

  switch (route.name) {
    case 'offline':
      return S.offline(library.error ?? 'Offline', syncedAt(library.fetchedAt));

    case 'home':
      // The header carries a one-shot notice (how a refresh went) or marks a
      // stale library, so the glasses cannot imply the data is current while
      // the phone shows an offline banner.
      return S.home(homeOverview(), route.focus, operationNotice);

    case 'list':
      return S.list(route.view, rows, route.focus, operationNotice);

    case 'digest':
      return S.digest(
        feedDigest?.sections ?? [],
        route.focus,
        feedDigest?.fromBrain ?? false,
        digestLoading,
        feedDigest?.error ?? null,
        operationNotice,
      );

    case 'section': {
      const s = feedDigest?.sections[route.section];
      // The digest can be rebuilt underneath a section — fall back rather than
      // rendering an undefined section as a blank screen.
      if (!s) return S.digest(
        feedDigest?.sections ?? [], 0, feedDigest?.fromBrain ?? false,
        false, feedDigest?.error ?? null, operationNotice,
      );
      return S.section(s, route.focus, operationNotice);
    }

    case 'summary': {
      const d = findDoc(route.id);
      if (!d) return S.home(homeOverview());
      const [text, fromBrain, status, gist] = summaryArgs(articles.get(route.id), d);
      return S.summary(d, text, fromBrain, status, route.page, articleSection(route), {
        ...gist,
        notice: operationNotice,
        hasNext: hasNext(route),
      });
    }

    case 'reader': {
      const d = findDoc(route.id);
      if (!d) return S.home(homeOverview());
      const a = articles.get(route.id);
      const opts = { hasNext: hasNext(route) };
      if (!a) return S.readerStatus(d, 'Loading the article…', articleSection(route), opts);
      if (!a.text) {
        return S.readerStatus(
          d, a.error ?? 'No readable text for this article.', articleSection(route), opts,
        );
      }
      return S.reader(d, a.text, route.page, articleSection(route), opts);
    }

    case 'ask':
      switch (route.phase) {
        case 'listening': return S.askListening();
        case 'transcribing': return S.askWorking('transcribing', '');
        case 'searching': return S.askWorking('searching', question?.heard ?? '');
        case 'answering': return S.askWorking('answering', question?.heard ?? '', question?.found ?? 0);
        case 'answer':
          return question
            ? S.askAnswer(question.heard, question.answer, question.picks, route.page)
            : S.askError('The answer was lost — ask again.');
        case 'error': return S.askError(question?.error ?? 'Something went wrong.');
      }
      return S.askListening();

    case 'answers':
      return S.answers(question?.picks ?? [], route.focus);
  }
}

const render = () => draw(currentScreen());

// -------------------------------------------------------------------- voice

/**
 * DEV ONLY — a recorded question instead of the glasses microphone, for the
 * simulator, which has no microphone of its own on a Mac mini. Set to a URL
 * serving raw 16 kHz s16le mono PCM (the stand-in serves one). Fixed at build
 * time like the other VITE_ variables, and never set for a packaged build.
 */
const FAKE_MIC = import.meta.env?.VITE_FAKE_MIC as string | undefined;

/** Open the glasses microphone. False when it would not open. */
async function openMic(): Promise<boolean> {
  if (FAKE_MIC) { void playFakeMic(FAKE_MIC); return true; }
  // The mic needs the startup page to exist (SDK README) — it always does by
  // the time anyone can ask; drawing Home created it.
  return serial(() => withTimeout(bridge.audioControl(true, AudioInputSource.Glasses)))
    .catch(() => false);
}

async function closeMic(): Promise<void> {
  if (!mic) return;
  mic = null;
  if (FAKE_MIC) return;
  await serial(() => withTimeout(bridge.audioControl(false))).catch(() => {});
}

/**
 * A frame from the microphone: keep it, and send once he stops talking.
 *
 * Runs synchronously on the event, not on the input queue: frames arrive many
 * times a second, and queueing each behind gestures would let the recording
 * fall behind the speech. The send itself IS queued — as the same press a
 * person would make, so both paths go through the reducer.
 */
function onAudio(frame: Uint8Array): void {
  const m = mic;
  if (!m || route.name !== 'ask' || route.phase !== 'listening') return;
  m.speech.push(frame);
  const heard = m.ends.feed(frame);
  if (m.sending) return;
  if (heard === 'done' || m.speech.truncated) {
    m.sending = true;
    enqueueInput(() => handleGesture('press'));
  } else if (heard === 'nothing') {
    m.sending = true;
    enqueueInput(async () => {
      if (mic !== m) return;
      await closeMic();
      await fail(m.seq, "Didn't hear anything.");
    });
  }
}

/** The mic was interrupted — the menu opened, the app went away, the page hid. */
async function micInterrupted(): Promise<void> {
  const m = mic;
  if (!m) return;
  await closeMic();
  await fail(m.seq, 'Stopped listening.');
}

async function playFakeMic(url: string): Promise<void> {
  const seq = mic?.seq;
  const pcm = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const size = BYTES_PER_SECOND / 10;
  // Real time, 100 ms frames, as the glasses send — then the room's silence,
  // until the pause detector or a press sends it.
  for (let at = 0; mic && mic.seq === seq; at += size) {
    onAudio(at < pcm.length ? pcm.subarray(at, at + size) : new Uint8Array(size));
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Move the question to a phase — if it is still the question on screen. */
async function toPhase(seq: number, phase: AskPhase): Promise<void> {
  if (seq !== askSeq || route.name !== 'ask') return;
  route = { ...route, phase, page: 0 };
  await render();
}

async function fail(seq: number, message: string): Promise<void> {
  if (seq !== askSeq) return;
  question = { ...(question ?? { heard: '', found: 0, answer: '', picks: [] }), seq, error: message };
  await toPhase(seq, 'error');
}

/** A document an answer points at — the loaded copy when there is one. */
function resolvePick(id: string, found: LibrarySearch): Doc {
  return library?.docs.find((d) => d.id === id)
    ?? feedDigest?.sections.flatMap((s) => s.docs).find((d) => d.id === id)
    ?? docFromHit(found.documents.find((d) => d.id === id)
      ?? { id, title: 'Untitled', author: null, category: null, passages: [] });
}

/**
 * The mic has closed on a question: hear it, search for it, answer it.
 *
 * Three board calls, each checked against `askSeq` on return — the user can
 * cancel or ask again at any point, and a late answer to an abandoned
 * question must not take over the screen.
 */
async function sendQuestion(): Promise<void> {
  const m = mic;
  if (!m) return;
  const seq = m.seq;
  await closeMic();
  const pcm = m.speech.pcm();
  // A press straight after the mic opened has nothing worth transcribing.
  if (pcm.length < MIN_UTTERANCE_BYTES) return fail(seq, "Didn't hear anything.");
  try {
    const heard = await transcribe(pcm);
    if (!isCurrent(seq, askSeq)) return;
    if (!isQuestion(heard)) return fail(seq, "Didn't catch that.");
    question = { seq, heard, found: 0, answer: '', picks: [], error: null };
    await toPhase(seq, 'searching');
    const found = await searchLibrary(heard);
    if (!isCurrent(seq, askSeq)) return;
    // The longest wait is the Claude turn that follows; say the search is done.
    question = { ...question, found: found.documents.length };
    await toPhase(seq, 'answering');
    const a = await askLibrary(heard, found, queueFrom(library?.docs ?? [], readingMinutes));
    if (!isCurrent(seq, askSeq)) return;
    question = {
      seq, heard, found: found.documents.length, answer: a.answer, error: null,
      picks: a.picks.map((p) => ({ doc: resolvePick(p.id, found), why: p.why })),
    };
    await toPhase(seq, 'answer');
  } catch (e) {
    await fail(seq, (e as Error).message || 'Something went wrong.');
  }
}

// ------------------------------------------------------------------ effects

/**
 * Load an article's text, and a summary only if one is already cached.
 *
 * Returns the in-flight load when there is one. Pressing again is the natural
 * response to "nothing happened", and re-requesting there turned a single 429
 * into a burst against the endpoint that had just rejected us.
 */
function openArticle(id: string): Promise<void> {
  if (articles.has(id)) return Promise.resolve();
  const inFlight = opening.get(id);
  if (inFlight) return inFlight;
  const doc = findDoc(id);
  if (!doc) return Promise.resolve();

  const load = (async () => {
    const t = await loadArticleText(deps(), doc);
    const a: Article = {
      doc, text: t.text, error: t.error,
      summary: t.cachedSummary,
      summarising: false,
      resume: t.resume, finished: false,
    };
    remember(id, a);
    // Pressed into the reader before the text arrived: it opened at sheet 0
    // because nothing was known. Move it to where the article was left — the
    // reader cannot have turned a sheet yet, a loading screen has only one.
    if (route.name === 'reader' && route.id === id && route.page === 0) {
      route = { ...route, page: resumeSheet(id) };
    }
    await render();
  })().finally(() => opening.delete(id));
  opening.set(id, load);
  return load;
}

/**
 * Summarise an article — only ever because the menu asked.
 *
 * One request per article however often it is asked: a second ask while the
 * first is out is dropped, and a cached summary is never re-asked. A failure is
 * NOT shown as the summary: the preview stays, the notice says so, and the menu
 * still offers a retry. (Showing an extract was the fallback when the summary
 * was the page; now the preview already is the article's own words.)
 */
async function summariseOpen(id: string): Promise<void> {
  await openArticle(id);
  const a = articles.get(id);
  if (!a || a.summary || a.summarising || !a.text) return;
  a.summarising = true;
  await render();
  const s = await summariseArticle(deps(), a.doc, a.text);
  a.summarising = false;
  if (s.fromBrain) a.summary = s.text;
  const onIt = route.name === 'summary' && route.id === id;
  if (onIt) operationNotice = s.fromBrain ? null : `○ ${s.error ?? 'Summary unavailable · try again later'}`;
  await render();
}

/**
 * Refill the Feed picks after archives left gaps in them: one bounded feed
 * reload and fresh triage, excluding what was archived. Only ever runs with the
 * digest on screen — see `feedArchived`.
 */
async function refreshFeedPicks(prefix = ''): Promise<void> {
  if (digestLoading) return;
  const excludeIds = feedArchived;
  // Cleared before the attempt, not after success. A failed refill is reported
  // and the pruned digest kept; retrying it on every visit would spend a feed
  // fetch and a model turn each time the digest is glanced at.
  feedArchived = [];
  digestLoading = true;
  operationNotice = `${prefix}□ Refreshing Feed…`;
  await render();
  const pruned = feedDigest;
  const refreshed = await loadFeedDigest(deps(), { forceTriage: true, excludeIds });
  digestLoading = false;
  if (refreshed.error && refreshed.sections.length === 0) {
    feedDigest = pruned;
    operationNotice = `${prefix}○ Feed refresh unavailable`;
  } else {
    feedDigest = refreshed;
    operationNotice = `${prefix}■ Feed refreshed`;
    if (route.name === 'digest') route = { ...route, focus: 0 };
  }
  await render();
}

/**
 * Show how an effect turned out — if the screen it was started from is still
 * the one up. A result arriving after the user has moved on belongs to a
 * screen they have left, and would read as being about the one they are on.
 */
async function report(from: Route, notice: string): Promise<void> {
  if (route !== from) return;
  operationNotice = notice;
  await render();
}

// Position updates are read-modify-write over one map. Effects run off the
// input queue, so serialize these separately to retain every rapid sheet turn.
let progressChain: Promise<unknown> = Promise.resolve();
function saveProgress(id: string, progress: number): Promise<unknown> {
  // Update the next Continue/Surprise selection without fetching or repainting
  // the sheet currently being read. Preserve the existing drawn row order.
  sessionProgress[id] = progress;
  // Respect v0.5.1's single library writer, including refresh/archive races.
  if (library) void libraryWrites.commit((s) => s!, false);
  rows = withReadingProgress(rows, { [id]: progress });
  const currentDeps = deps();
  progressChain = progressChain.catch(() => {}).then(() => recordProgress(currentDeps, id, progress));
  return progressChain;
}

async function flushReadingState(): Promise<void> {
  await progressChain.catch(() => {});
  await storage.flush().catch(() => {});
}

/** Also covers voice-open → switch app / lock phone, without redrawing a sheet. */
async function suspend(): Promise<void> {
  await Promise.all([flushReadingState(), micInterrupted()]);
}

async function perform(effect: Effect): Promise<void> {
  switch (effect.kind) {
    case 'none':
      return;

    case 'refresh':
      // Asked for: skip the fresh cache. Still one bounded fetch, not a poll.
      await refresh({ force: true });
      return;

    case 'loadDigest': {
      if (effect.refresh && feedDigest && !effect.retry) {
        await refreshFeedPicks();
        return;
      }
      // Already built this session — reuse it. The digest costs a feed fetch
      // plus a full Claude turn, so re-entering it must not pay that again;
      // `app.ts` caches across launches, this covers the same launch.
      if ((feedDigest && !effect.retry) || digestLoading) return;
      if (effect.retry) feedDigest = null;
      digestLoading = true;
      await render();
      try {
        feedDigest = await loadFeedDigest(deps(), { excludeIds: feedArchived });
        feedArchived = [];
      } catch (e) {
        console.error('[readwise] digest failed', e);
        feedDigest = { sections: [], fromBrain: false, considered: 0, builtAt: 0,
          error: (e as Error).message };
      }
      digestLoading = false;
      await render();
      return;
    }

    case 'openSummary':
    case 'openReader':
      await openArticle(effect.id);
      return;

    case 'summarise':
      await summariseOpen(effect.id);
      return;

    case 'savePosition': {
      const a = articles.get(effect.id);
      if (!a?.text) return;
      const progress = S.sheetProgress(S.readerSheets(a.doc, a.text), effect.page, a.text.length);
      a.resume = progress;
      await saveProgress(effect.id, progress);
      return;
    }

    case 'finished': {
      // Every line has been on screen. Recorded as 1 — locally, since
      // Readwise's progress cannot be written through the API — once, however
      // many times the reader swipes against the end.
      // Not on an article whose text never arrived: a swipe on its error
      // screen is not reading it, and must not mark it read in Readwise.
      const a = articles.get(effect.id);
      if (!a?.text || a.finished) return;
      a.finished = true;
      a.resume = 1;
      await saveProgress(effect.id, 1);
      return;
    }

    case 'archive': {
      if (!library) return;
      const landed = route;
      // The route already shows the next article. Its text is fetched while
      // Readwise handles the archive, rather than after.
      if (effect.next) void openArticle(effect.next);

      const r = await archiveRemote(deps(), effect.id);
      if (!r.archived) {
        // Nothing local was removed for a pending archive, but a refresh that
        // landed meanwhile may have been fetched without it: put it back from
        // that snapshot, so a failed archive never loses the article.
        await libraryWrites.commit((s) => restoreDoc(s!, lastFetched, effect.id), false);
        await report(landed, effect.next ? '○ Archive failed · previous article kept' : '○ Archive failed · article kept');
        return;
      }
      // Confirmed: removed from the library as it stands NOW, serialised with
      // every other write, and remembered — on the chain — so a refresh
      // cannot resurrect it.
      await libraryWrites.commit((s) => {
        archived.confirm(effect.id);
        return withoutDoc(s!, effect.id);
      });
      articles.delete(effect.id);
      // Drop the archived row from the held list rather than re-selecting —
      // re-selecting would redraw a Surprise view and move everything under
      // the focus cursor as a side effect of archiving one item.
      pruneRows();
      // The archived article may have come from the digest rather than the
      // library, and the digest is a separate list held in its own state — the
      // library prune above cannot see it, so the row would stay on screen.
      pruneDigest(effect.id);
      // And from an answer's list, if that is where it was opened.
      if (question) question = { ...question, picks: question.picks.filter((p) => p.doc.id !== effect.id) };
      if (effect.refreshFeed) feedArchived.push(effect.id);

      if (effect.next) {
        await report(landed, '■ Previous article archived');
        return;
      }
      // Landed back on the digest: the gap is on screen, so fill it now. This
      // is still lazy — it happens because the user archived a Feed pick.
      if (effect.refreshFeed && route === landed && route.name === 'digest') {
        await refreshFeedPicks('■ Archived · ');
        return;
      }
      await report(landed, '■ Archived in Readwise');
      return;
    }

    case 'listen': {
      const seq = ++askSeq;
      question = null;
      await closeMic();
      mic = { seq, speech: utterance(), ends: endpointer(), sending: false };
      const ok = await openMic();
      if (mic?.seq !== seq) {
        // Cancelled while the mic was opening. A late open must not stay open.
        if (ok && !FAKE_MIC) await serial(() => withTimeout(bridge.audioControl(false))).catch(() => {});
        return;
      }
      if (!ok) {
        mic = null;
        await fail(seq, 'The glasses microphone did not start.');
      }
      return;
    }

    case 'sendQuestion':
      await sendQuestion();
      return;

    case 'cancelAsk':
      askSeq++;
      question = null;
      await closeMic();
      return;

    case 'exit':
      // Push any debounced reading position out BEFORE leaving: this is the one
      // moment we know the app is going away, and a position still sitting in
      // the buffer would be lost with it.
      await flushReadingState();
      // exitMode 1 shows the system confirmation. QA rejects silent exits.
      await serial(() => withTimeout(bridge.shutDownPageContainer(1)));
      return;
  }
}

// ------------------------------------------------------------------- input

// Gesture decoding lives in `main-gestures.ts` so it can be unit-tested — this
// file top-level-awaits the bridge, so a test importing it would hang. That
// test is the only guard against lifecycle events being decoded as presses,
// which the simulator cannot reproduce.

// The listener is `onEvenHubEvent`, NOT `onEvent`. Writing `onEvent?.()` means
// the optional-call silently no-ops and no gesture EVER reaches the app on
// hardware — a bug the simulator hides, because its injected input takes a
// different path.
let inputChain: Promise<void> = Promise.resolve();
const enqueueInput = (fn: () => Promise<void>) => {
  inputChain = inputChain.then(fn, fn).catch(() => {});
};

bridge.onEvenHubEvent((event) => {
  // Audio first, and at once — see `onAudio`.
  const pcm = event.audioEvent?.audioPcm;
  if (pcm) { onAudio(pcm); return; }
  const lifecycle = lifecycleFrom(event);
  if (lifecycle === 'exit') enqueueInput(suspend);
  else if (mic && lifecycle === 'overlay') enqueueInput(micInterrupted);
  const menuID = event.menuItemClickEvent?.itemID;
  if (menuID !== undefined) {
    enqueueInput(() => handleMenu(menuID));
    return;
  }
  const gesture = gestureFrom(event);
  if (gesture) enqueueInput(() => handleGesture(gesture));
});

function navContext(): NavContext {
  const open = route.name === 'summary' || route.name === 'reader' ? route : null;
  const a = open ? articles.get(open.id) : undefined;
  const d = open ? findDoc(open.id) : undefined;
  let summaryPages = 1;
  if (route.name === 'summary' && d) {
    // Measured from what is drawn for THIS route — a count from another
    // article, or without the notice line, would let a swipe run past the end.
    const [text, fromBrain, status, gist] = summaryArgs(a, d);
    summaryPages = S.summarySheets(d, text, fromBrain, status, operationNotice, gist).length;
  }
  return {
    rows,
    pages: route.name === 'reader' && a?.text ? S.readerSheets(a.doc, a.text).length : 1,
    summaryPages,
    resumePage: route.name === 'summary' ? resumeSheet(route.id) : 0,
    // Nothing to enter while the digest is being rebuilt: a section pressed
    // now would be an index into picks that are about to be replaced.
    sections: digestLoading && route.name === 'digest' ? [] : feedDigest?.sections ?? [],
    digestLoaded: feedDigest !== null,
    digestError: Boolean(feedDigest?.error),
    digestStale: feedArchived.length > 0,
    answerPages: route.name === 'ask' && route.phase === 'answer' && question
      ? S.askAnswerSheets(question.heard, question.answer, question.picks).length
      : 1,
    answerDocs: question?.picks.map((p) => p.doc) ?? [],
  };
}

// The webview hidden — phone locked, app switched — must not leave a live mic.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) enqueueInput(suspend);
});
addEventListener('pagehide', () => enqueueInput(suspend));

async function handleMenu(itemID: number): Promise<void> {
  const gesture = S.gestureForMenuItem(itemID);
  if (gesture) return handleGesture(gesture);
}

async function handleGesture(g: Gesture): Promise<void> {
  if (g === 'hold') {
    const now = Date.now();
    if (!acceptHold(lastHoldAt, now)) return;
    lastHoldAt = now;
  }

  const from = route;
  const next = step(route, navContext(), g);
  // A gesture that changes nothing must DRAW nothing. On a reading sheet the
  // common case is a swipe against the end of the article; a redraw there
  // would snap the firmware's scroll back to the top of the sheet.
  if (next.route === route && next.effect.kind === 'none') return;

  // Hollow while pending, filled when done, empty circle on failure — the
  // notice is a line of the sheet at full brightness, so the glyph is what
  // tells it apart from the title under it. ✓ is not in the firmware font.
  operationNotice = next.effect.kind === 'archive'
    ? (next.effect.next ? '□ Archiving previous…' : '□ Archiving in Readwise…')
    : next.effect.kind === 'refresh' ? '□ Refreshing library…'
      : null;
  route = next.route;

  // The mic is open only while the listening screen is up. Leaving it by any
  // door — the menu, a section jump — closes it; sending hands it over first.
  if (mic && !(route.name === 'ask' && route.phase === 'listening') && next.effect.kind !== 'sendQuestion') {
    void closeMic();
  }

  // Draw the list ONCE when a section is entered — from the contextual menu, a
  // press on its Home row, or a press on another, empty list — not per render
  // and not on the way back from an article. Backing out of a summary or
  // reader must land on the same rows in the same order; redrawing there would
  // reshuffle Surprise under the cursor.
  const entered = route.name === 'list' && (
    destinationForGesture(g) !== null
    || from.name === 'home'
    || (from.name === 'list' && from.view !== route.view)
  );
  if (entered && route.name === 'list') enterView(route.view);

  try {
    await render();        // move first, so the HUD feels immediate
  } catch (e) {
    // A throw here would be an unhandled rejection on the input path, which
    // leaves the HUD unresponsive to every later gesture.
    console.error('[readwise] render failed', e);
  }
  // Effects run OFF the input chain. They used to be awaited on it, so a
  // summary — a Claude turn, up to 95s — froze every gesture behind it: the
  // user could not even back out, and each press made meanwhile replayed in a
  // burst when it finally landed. Every effect re-renders from current state
  // when it finishes, so the screen it lands on is whatever the user is on.
  void perform(next.effect).catch((e) => console.error('[readwise] effect failed', e));
}

// ------------------------------------------------------------------- load

/**
 * Load the library. Called once at startup and on an explicit retry.
 *
 * There is NO poll. The rate limit is 20 requests/minute, the library is
 * human-paced, and `app.ts` serves a 15-minute cache — a background poll would
 * spend the budget on data nobody is looking at.
 */
/**
 * Single-flight end to end: a refresh asked for while one is running joins it.
 * Two overlapping refreshes let the newer finish first, forget an archive's
 * marker, and then the older snapshot brought the article back.
 */
const refresh = singleFlight(async (opts: { force?: boolean } = {}): Promise<void> => {
  const from = route;
  try {
    // Ticketed before the fetch: a marker confirmed after this moment is kept
    // until a snapshot that could have known about it says the article is gone.
    const startedAt = archived.tick();
    const fetched = await loadLibraryState(deps(), opts);
    lastFetched = fetched;
    // Nothing archived this session comes back with a snapshot, however old
    // the snapshot. Filtering, the bookkeeping and the decision to re-cache
    // are ONE commit, reading the markers at commit time: an archive confirmed
    // while this refresh was in flight is already marked when the update
    // runs, or removes itself from the published state right after. A
    // confirmed archive Readwise no longer returns is done with. The snapshot
    // is already cached, so it is re-saved only when something was pruned.
    let prunedAny = false;
    await libraryWrites.commit(() => {
      const { state, pruned } = pruneArchived(fetched, archived.ids());
      archived.settle(startedAt, pruned);
      prunedAny = pruned.length > 0;
      return state;
    }, (next) => prunedAny && wasFetched(next));
    if (!library) return;
    // No token yet: the welcome screen, which retries on press like offline.
    if (library.docs.length === 0 && library.error === NO_TOKEN) {
      route = { name: 'offline' };
    } else if (route.name === 'offline' && library.docs.length > 0) {
      route = { name: 'home', focus: 0 };
    }
    if (opts.force && route === from) {
      operationNotice = library.error
        ? `○ Refresh failed · ${library.error}`
        : `■ Library refreshed · ${library.docs.length} articles`;
    }
    // The held rows are reconciled on EVERY route, not only a list: an article
    // open from a list that is refreshed underneath it would otherwise back out
    // into rows the library no longer has. Order is kept and Surprise is not
    // reshuffled; a list on screen (other than Surprise) is re-selected so new
    // documents appear, with focus staying on the same article where it can.
    // Every index into the rows — the list's focus, an open article's way
    // back, where a question returns to — follows its document.
    const before = rows;
    if (route.name === 'list' && route.view !== 'surprise') enterView(route.view);
    else rows = reconcileRows(rows, library.docs);
    route = repointFocus(route, before, rows);
  } catch (e) {
    // loadLibraryState is written not to throw, but a bug there must not
    // freeze the HUD on its last frame with no screen and no log.
    console.error('[readwise] library load failed', e);
    await libraryWrites.commit(() => ({ docs: [], fetchedAt: 0, stale: true, error: (e as Error).message }), false);
  }
  try {
    await render();
  } catch (e) {
    console.error('[readwise] render failed', e);
  }
});

// Draw BEFORE the library is asked for. The first frame used to wait on the
// whole fetch — bridge, hydration, then up to six Readwise requests — and the
// glasses showed the OS launch state meanwhile; the loading screen existed but
// nothing ever drew it (found 2026-10-29). One extra rebuild, and a frame at once.
await render().catch((e) => console.error('[readwise] first render failed', e));
await refresh();
