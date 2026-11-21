/**
 * Navigation. Five direct gestures plus contextual-menu section jumps.
 *
 * Pure: (route, data, gesture) → next route + optional effect. Effects are
 * returned rather than performed, so the caller owns every side effect and the
 * whole state machine is unit-testable without hardware.
 *
 * Press, double press, swipe up and swipe down operate within the current
 * section; a plain hold archives the open article. The OS contextual menu
 * switches sections without forcing the user to backtrack through Home. Menu
 * selections are still plain reducer inputs; IO remains an effect owned by
 * main.ts.
 *
 * The flow the card specifies, and which this enforces:
 *
 *     Home → List → Article → (opt in) Reader
 *                      │  ↑___ hold: archive ___|→ next Article
 *                      └─ menu: Summarise (opt in)
 *
 * The article's front page (route `summary`) opens on a free preview — the
 * publisher's blurb or the article's opening. A Brain summary is a Claude
 * session on the mini, so it is asked for from the menu, never assumed: when
 * every open asked, swiping through a list started a session per row
 * (2026-11-19).
 *
 * Each step is a deliberate gesture. The reader is never entered from the
 * list, because fetching full text costs a request against a 20/min budget and
 * a long article is a commitment. The one thing that opens without a press is
 * the NEXT article after an archive — the hold that archived was the request to
 * move on, and landing back on the list would cost a press to do what was asked.
 */

import type { Doc } from '../readwise/client';
import { nextAfter, focusOn, type ViewKey } from '../readwise/views';
import { boardEnabled } from '../build';

// Re-exported: the reducer's tests and the shell reach it through nav.
export { nextAfter };

export type SectionNavigationGesture =
  | 'navRecent'
  | 'navContinue'
  | 'navFeed'
  | 'navSurprise';

export type Gesture =
  | 'press'
  | 'double'
  | 'up'
  | 'down'
  | 'archive'
  /** A plain long press. Tap-then-hold belongs to the OS menu and never arrives. */
  | 'hold'
  /** "Ask your library", from the contextual menu on any screen. */
  | 'navAsk'
  /**
   * "Refresh library", from the contextual menu on any screen. The library is
   * a 15-minute cache and nothing polls, so this is the one way to see a save
   * made on the phone a moment ago. The route does not move.
   */
  | 'navRefresh'
  /** "Summarise", from the menu on an article's front page. */
  | 'summarise'
  | SectionNavigationGesture;

/**
 * Where an article was opened from, so backing out returns to the same place.
 * Absent means a library list, which is the original path and stays the default.
 */
export type Origin =
  | { kind: 'section'; section: number }
  /** Opened from the documents an answer pointed at; `from` is where the question was asked. */
  | { kind: 'answers'; from: Route };

/**
 * A spoken question, from mic to answer. The shell moves it between phases as
 * results arrive; the reducer only starts, sends, pages and leaves it.
 */
export type AskPhase = 'listening' | 'transcribing' | 'searching' | 'answering' | 'answer' | 'error';

export type Route =
  | { name: 'home'; focus: number }
  /** The feed digest: sections, not articles. Press one to see its titles. */
  | { name: 'digest'; focus: number }
  | { name: 'list'; view: ViewKey; focus: number }
  /** Titles inside one digest section. `section` indexes into the digest. */
  | { name: 'section'; section: number; focus: number }
  /**
   * `origin` is where a press came from, so backing out returns there. The
   * digest reaches the summary through a SECTION, not a list, and without this
   * the way back was hard-coded to a view — leaving the digest by the wrong door.
   */
  | { name: 'summary'; view: ViewKey; id: string; back: number; page: number; origin?: Origin }
  /** `page` is a SHEET: ~900 bytes the firmware scrolls, not one screenful. */
  | { name: 'reader'; view: ViewKey; id: string; page: number; back: number; origin?: Origin }
  | { name: 'offline' }
  /** A question to the library. `from` is where it was asked, and where leaving returns. */
  | { name: 'ask'; phase: AskPhase; page: number; from: Route }
  /** The documents an answer pointed at, as openable cards. */
  | { name: 'answers'; focus: number; from: Route };

/** Side effects the reducer asks for but never performs itself. */
export type Effect =
  | { kind: 'none' }
  | { kind: 'refresh' }
  /**
   * Fetch the feed and triage it. Costs a model turn, so only on entry.
   * `refresh` forces fresh triage after Feed archives left gaps in the picks.
   */
  | { kind: 'loadDigest'; retry?: boolean; refresh?: boolean }
  /** Fetch an article's text, for its front page. Never asks the Brain. */
  | { kind: 'openSummary'; id: string }
  /** Ask the Brain to summarise the open article. Only ever on request. */
  | { kind: 'summarise'; id: string }
  /** Fetch full text and enter the reader. */
  | { kind: 'openReader'; id: string }
  /** Persist the sheet reached, as the reader's local position. */
  | { kind: 'savePosition'; id: string; page: number }
  /** A swipe past the end of the last sheet: the article has been read. */
  | { kind: 'finished'; id: string }
  /**
   * Archive, and when `next` names an article, open it — the route already
   * shows it. `refreshFeed` marks an archive that leaves a gap in the Feed
   * picks: refilled at once when the reader lands back on the digest, or on the
   * next visit to it when the reader moved straight on to another article.
   */
  | { kind: 'archive'; id: string; refreshFeed: boolean; next?: string }
  | { kind: 'exit' }
  /** Open the microphone for a new question. */
  | { kind: 'listen' }
  /** Close the microphone and put what was said to the library. */
  | { kind: 'sendQuestion' }
  /** Close the microphone and forget the question, wherever it had got to. */
  | { kind: 'cancelAsk' };

export type Step = { route: Route; effect: Effect };

const none = (route: Route): Step => ({ route, effect: { kind: 'none' } });

/**
 * Clamp focus into a list. Clamped, not wrapped, like Home and the sheets:
 * wrapping took a swipe past `20/20` silently to `1/20`, which on a display
 * with no scrollbar read as the list jumping. The counter says where the end is.
 */
const clamp = (i: number, len: number) => Math.min(Math.max(0, i), Math.max(0, len - 1));

/** Move focus by a swipe; the same route back when it cannot move, so nothing redraws. */
function moveFocus<R extends Route & { focus: number }>(route: R, g: Gesture, len: number): Step {
  const focus = clamp(route.focus + (g === 'down' ? 1 : -1), len);
  return none(focus === route.focus ? route : { ...route, focus });
}

/**
 * Stable section order shared by route history and the contextual menu.
 *
 * `digest` is deliberately NOT a fourth `ViewKey`. The other destinations are pure
 * selectors over the already-fetched library; the digest is over the FEED, and
 * needs a fetch plus a model turn to produce sections rather than a flat list.
 * Making it a ViewKey would have `select()` claim it can do something it cannot.
 */
export type Destination = ViewKey | 'digest';

/** A row on Home: a section, or asking. */
export type HomeItem = Exclude<Destination, 'today'> | 'ask';

/**
 * Home's rows, top to bottom. Order follows Anton's own Reader home: what just
 * arrived, what fits the moment, the feed, what is half done, then the long
 * reads and the draw. Ask is last — it is also on every menu.
 */
export function homeViews(withAsk: boolean): HomeItem[] {
  const rows: HomeItem[] = ['recent', 'quick', 'digest', 'halfread', 'long', 'surprise'];
  return withAsk ? [...rows, 'ask'] : rows;
}

/**
 * This build's Home. The public app has no voice Ask — it needs the Brain for
 * speech-to-text — so its Home ends at Surprise me (`build.ts`).
 */
export const HOME_VIEWS: HomeItem[] = homeViews(boardEnabled());

/** Where backing out of a section lands on Home: its own row. */
const homeAt = (item: Destination): Route => ({
  name: 'home', focus: Math.max(0, HOME_VIEWS.indexOf(item as HomeItem)),
});

const SECTION_DESTINATIONS: Record<SectionNavigationGesture, Destination> = {
  navRecent: 'recent',
  navContinue: 'halfread',
  navFeed: 'digest',
  navSurprise: 'surprise',
};

export function destinationForGesture(g: Gesture): Destination | null {
  return g in SECTION_DESTINATIONS
    ? SECTION_DESTINATIONS[g as SectionNavigationGesture]
    : null;
}

export type NavContext = {
  /** The documents currently in the focused view, in render order. */
  rows: Doc[];
  /** Sheets in the open article, once its text is loaded. */
  pages: number;
  /** Sheets in the open summary. 1 until it has been fetched. */
  summaryPages: number;
  /**
   * The sheet the reader reopens at for the open article — where it was left.
   * 0 until its text is loaded; the shell corrects the route when it arrives.
   */
  resumePage: number;
  /** Digest sections, in render order. Empty until the digest is loaded. */
  sections: Array<{ docs: Doc[] }>;
  /** Distinguishes a not-yet-opened Feed from a loaded but genuinely empty one. */
  digestLoaded: boolean;
  /** A failed Feed fetch can be retried only by an explicit press. */
  digestError: boolean;
  /** A Feed article was archived since the digest was built; its picks have a gap. */
  digestStale: boolean;
  /** Sheets in the answer on screen. */
  answerPages: number;
  /** The documents the answer pointed at, as openable docs. */
  answerDocs: Doc[];
};

/**
 * The screen behind an open article.
 *
 * A digest article was reached through a section, a library article through a
 * list. Hard-coding the list here sent the digest out by the wrong door — back
 * from a feed article landed in "Today" rather than the section it came from.
 */
function behind(route: { view: ViewKey; back: number; origin?: Origin }): Route {
  if (route.origin?.kind === 'answers') {
    return { name: 'answers', focus: route.back, from: route.origin.from };
  }
  return route.origin?.kind === 'section'
    ? { name: 'section', section: route.origin.section, focus: route.back }
    : { name: 'list', view: route.view, focus: route.back };
}

/**
 * Where leaving a question returns — never into the question flow itself, so
 * asking again from an answer, or from an article it pointed at, still backs
 * out to wherever the first question was asked.
 */
function askFrom(route: Route): Route {
  if (route.name === 'ask' || route.name === 'answers') return route.from;
  if ((route.name === 'summary' || route.name === 'reader') && route.origin?.kind === 'answers') {
    return route.origin.from;
  }
  return route;
}

const listen = (from: Route): Step => ({
  route: { name: 'ask', phase: 'listening', page: 0, from },
  effect: { kind: 'listen' },
});

export function step(route: Route, ctx: NavContext, g: Gesture): Step {
  // Asking is reachable from every screen, like the sections — in a build that
  // has it. The public menu never offers it; this is the belt to that brace.
  if (g === 'navAsk') return boardEnabled() ? listen(askFrom(route)) : none(route);
  // So is a refresh: the screen stays, the shell reports how it went.
  if (g === 'navRefresh') return { route, effect: { kind: 'refresh' } };
  const destination = destinationForGesture(g);
  if (destination === 'digest') {
    return { route: { name: 'digest', focus: 0 }, effect: enterDigest(ctx) };
  }
  if (destination) {
    return none({ name: 'list', view: destination, focus: 0 });
  }

  switch (route.name) {
    // Offline is a dead end by design: the only useful things are retry and
    // leave. Silently continuing into an empty list would be worse.
    case 'offline':
      if (g === 'press') return { route, effect: { kind: 'refresh' } };
      if (g === 'double') return { route, effect: { kind: 'exit' } };
      return none(route);

    case 'home': {
      // Double press at the ROOT exits via the system dialog. QA rejects apps
      // that exit silently, so this must reach shutDownPageContainer(1).
      if (g === 'double') return { route, effect: { kind: 'exit' } };
      // CLAMPED, unlike the lists: wrapping from the first section would jump
      // past the dashboard above it, which is what the top of Home is for.
      if (g === 'up' || g === 'down') {
        const last = HOME_VIEWS.length - 1;
        const focus = Math.min(last, Math.max(0, route.focus + (g === 'down' ? 1 : -1)));
        return none(focus === route.focus ? route : { ...route, focus });
      }
      if (g !== 'press') return none(route);
      const item = HOME_VIEWS[Math.min(route.focus, HOME_VIEWS.length - 1)];
      if (item === 'ask') return listen(route);
      if (item === 'digest') return { route: { name: 'digest', focus: 0 }, effect: enterDigest(ctx) };
      return none({ name: 'list', view: item, focus: 0 });
    }

    case 'ask':
      switch (route.phase) {
        case 'listening':
          // Press sends at once; a pause sends too (the shell's endpointer).
          if (g === 'press') {
            return { route: { ...route, phase: 'transcribing' }, effect: { kind: 'sendQuestion' } };
          }
          if (g === 'double') return { route: route.from, effect: { kind: 'cancelAsk' } };
          return none(route);
        case 'transcribing':
        case 'searching':
        case 'answering':
          if (g === 'double') return { route: route.from, effect: { kind: 'cancelAsk' } };
          return none(route);
        case 'answer': {
          if (g === 'up' || g === 'down') {
            const last = Math.max(0, ctx.answerPages - 1);
            const next = Math.min(last, Math.max(0, route.page + (g === 'down' ? 1 : -1)));
            return none(next === route.page ? route : { ...route, page: next });
          }
          if (g === 'double') return none(route.from);
          if (g !== 'press') return none(route);
          // Press goes where the answer points — or, when it points nowhere,
          // straight into asking again.
          return ctx.answerDocs.length > 0
            ? none({ name: 'answers', focus: 0, from: route.from })
            : listen(route.from);
        }
        case 'error':
          if (g === 'press') return listen(route.from);
          if (g === 'double') return none(route.from);
          return none(route);
      }
      return none(route);

    case 'answers': {
      const len = ctx.answerDocs.length;
      if (g === 'up' || g === 'down') return moveFocus(route, g, len);
      if (g === 'double') return none({ name: 'ask', phase: 'answer', page: 0, from: route.from });
      if (g !== 'press' || len === 0) return none(route);
      const doc = ctx.answerDocs[Math.min(route.focus, len - 1)];
      return {
        route: {
          name: 'summary', view: 'recent', id: doc.id, back: route.focus, page: 0,
          origin: { kind: 'answers', from: route.from },
        },
        effect: { kind: 'openSummary', id: doc.id },
      };
    }

    // Sections, not articles. Press enters one; double goes home.
    case 'digest': {
      const len = ctx.sections.length;
      if (g === 'up' || g === 'down') return moveFocus(route, g, len);
      if (g === 'double') return none(homeAt('digest'));
      // Only a PRESS enters. Every other input used to fall through to here,
      // which was harmless while the menu was the only other source — a plain
      // hold now reaches the app, and must not open a section.
      if (g !== 'press') return none(route);
      if (len === 0) {
        return ctx.digestError
          ? { route, effect: { kind: 'loadDigest', retry: true } }
          : none(route);
      }
      return none({ name: 'section', section: Math.min(route.focus, len - 1), focus: 0 });
    }

    case 'section': {
      const docs = ctx.sections[route.section]?.docs ?? [];
      const len = docs.length;
      if (g === 'up' || g === 'down') return moveFocus(route, g, len);
      // Back to the digest, with the section that was entered still focused —
      // refilling its picks first if an archive has left a gap in them.
      if (g === 'double') {
        return { route: { name: 'digest', focus: route.section }, effect: stale(ctx) };
      }
      if (g !== 'press' || len === 0) return none(route);
      const doc = docs[Math.min(route.focus, len - 1)];
      return {
        route: {
          name: 'summary', view: 'today', id: doc.id, back: route.focus, page: 0,
          origin: { kind: 'section', section: route.section },
        },
        effect: { kind: 'openSummary', id: doc.id },
      };
    }

    case 'list': {
      const len = ctx.rows.length;
      if (g === 'up' || g === 'down') return moveFocus(route, g, len);
      if (g === 'double') return none(homeAt(route.view));
      if (g !== 'press') return none(route);
      // An empty list has nothing to open — so Press is the way on instead:
      // the dependable front door, or Home when that door is the empty one.
      // Reaching another section through the menu was tap, hold, swipe, tap.
      if (len === 0) {
        return none(route.view === 'recent' ? homeAt('recent') : { name: 'list', view: 'recent', focus: 0 });
      }
      const doc = ctx.rows[Math.min(route.focus, len - 1)];
      return {
        route: { name: 'summary', view: route.view, id: doc.id, back: route.focus, page: 0 },
        effect: { kind: 'openSummary', id: doc.id },
      };
    }

    case 'summary': {
      // Swipes inside a sheet never arrive — the firmware scrolls it. What
      // arrives is a swipe past the top or bottom, which turns the sheet.
      // Clamped, not wrapped: running off the end should stop, not jump back.
      if (g === 'up' || g === 'down') {
        const last = Math.max(0, ctx.summaryPages - 1);
        const next = Math.min(last, Math.max(0, route.page + (g === 'down' ? 1 : -1)));
        return none(next === route.page ? route : { ...route, page: next });
      }
      // Hold is the one-gesture archive the reading screens were missing: the
      // menu route to it is tap, hold, swipe, tap. Archive is a named move to
      // Readwise's Archive, not a delete, and the next screen says it happened.
      if (g === 'archive' || g === 'hold') return archive(route, ctx);
      if (g === 'double') return none(behind(route));
      // The route stays: the summary lands on this page when it arrives, and
      // the reader can press on into the article meanwhile.
      if (g === 'summarise') return { route, effect: { kind: 'summarise', id: route.id } };
      if (g !== 'press') return none(route);
      // Press is the deliberate opt-in to the full article, reopened where it
      // was left rather than at the top.
      return {
        route: {
          name: 'reader', view: route.view, id: route.id, page: ctx.resumePage,
          back: route.back, origin: route.origin,
        },
        effect: { kind: 'openReader', id: route.id },
      };
    }

    case 'reader': {
      const last = Math.max(0, ctx.pages - 1);
      if (g === 'up' || g === 'down') {
        // CLAMP, do not wrap. Running off the end of an article should stop at
        // the end; silently jumping back to the top reads as data loss.
        const next = Math.min(last, Math.max(0, route.page + (g === 'down' ? 1 : -1)));
        if (next === route.page) {
          // A swipe past the end of the LAST sheet is the one moment the app
          // knows every line has been on screen — the firmware only reports a
          // bottom swipe once the last line is showing.
          return g === 'down' && ctx.pages > 0
            ? { route, effect: { kind: 'finished', id: route.id } }
            : none(route);
        }
        return {
          route: { ...route, page: next },
          // Persist on every sheet turn rather than on exit: the app can be
          // backgrounded or the glasses removed at any moment, and an unsaved
          // position is the thing the resume feature exists to prevent.
          effect: { kind: 'savePosition', id: route.id, page: next },
        };
      }
      if (g === 'archive' || g === 'hold') return archive(route, ctx);
      if (g === 'double') return none(behind(route));
      if (g !== 'press') return none(route);
      // Press steps back to the summary — the way out that is not "leave".
      // Back from the reader lands on the TOP of the summary: the sheet the
      // reader was on has nothing to do with where the summary was scrolled to.
      return none({
        name: 'summary', view: route.view, id: route.id,
        back: route.back, page: 0, origin: route.origin,
      });
    }
  }
}

/**
 * Re-point every index into the library rows after the rows changed under the
 * route — a refresh landing while an article is open. Each index becomes the
 * index of the SAME document in the new rows, or is clamped when it is gone:
 * a list's focus, an article's `back` (where double lands), and the `from`
 * a question or its answers return to, recursively — including the `from`
 * behind an article opened from an answer. Indexes into a Feed section or an
 * answer's documents are untouched — those lists do not change with the
 * library (review of PR #1, rounds 2 and 3).
 */
export function repointFocus(route: Route, before: readonly Doc[], after: readonly Doc[]): Route {
  const at = (i: number) => focusOn(after, before[i]?.id ?? null, i);
  switch (route.name) {
    case 'list':
      return { ...route, focus: at(route.focus) };
    case 'summary':
    case 'reader': {
      const origin = route.origin;
      if (!origin) return { ...route, back: at(route.back) };
      if (origin.kind === 'answers') {
        return { ...route, origin: { ...origin, from: repointFocus(origin.from, before, after) } };
      }
      return route;
    }
    case 'ask':
    case 'answers':
      return { ...route, from: repointFocus(route.from, before, after) };
    default:
      return route;
  }
}

/** What entering the digest costs: nothing when held and whole, a load otherwise. */
function enterDigest(ctx: NavContext): Effect {
  if (!ctx.digestLoaded || ctx.digestError) {
    return { kind: 'loadDigest', ...(ctx.digestError ? { retry: true } : {}) };
  }
  return stale(ctx);
}

/**
 * A digest with archived picks is refilled when it is looked at, not when the
 * gap appears — the reader who archives and moves straight on to the next
 * article is not looking at the digest, and a model turn spent then is wasted.
 */
const stale = (ctx: NavContext): Effect =>
  ctx.digestStale ? { kind: 'loadDigest', refresh: true } : { kind: 'none' };

/**
 * Archive the open article and move on.
 *
 * The route moves at once, before Readwise answers, so the HUD feels
 * immediate. If the archive then fails the article is kept in its list and the
 * next screen says so — the user has moved on either way, and the kept article
 * is still there to retry.
 */
function archive(
  route: Extract<Route, { name: 'summary' | 'reader' }>,
  ctx: NavContext,
): Step {
  const origin = route.origin;
  const feed = origin?.kind === 'section';
  const docs = origin?.kind === 'section'
    ? ctx.sections[origin.section]?.docs ?? []
    : origin?.kind === 'answers' ? ctx.answerDocs : ctx.rows;
  const next = nextAfter(docs, route.id);
  if (next) {
    return {
      route: {
        name: 'summary', view: route.view, id: next.doc.id, back: next.index, page: 0, origin,
      },
      effect: { kind: 'archive', id: route.id, refreshFeed: feed, next: next.doc.id },
    };
  }
  return {
    // The last Feed pick of a section leaves the section itself empty, so the
    // way back is the digest — where the gap is refilled straight away.
    route: origin?.kind === 'section' ? { name: 'digest', focus: origin.section } : behind(route),
    effect: { kind: 'archive', id: route.id, refreshFeed: feed },
  };
}
