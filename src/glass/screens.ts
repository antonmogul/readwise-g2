/**
 * Every glasses screen, as data.
 *
 * Pure functions returning validated container specs. Nothing here touches the
 * SDK — `main.ts` is the only file that does. That split is what lets the whole
 * HUD be asserted in tests and previewed in the simulator without hardware, and
 * it is why the container budget is a test failure rather than an on-device
 * mystery.
 *
 * The canvas is 576×288 with a fixed 27px firmware line height and no font-size
 * control. Hierarchy comes from position, borders, per-container brightness
 * (SDK 0.0.14+) and wording.
 */

import {
  beginScreen, screen, header, footer, card, body, captureLayer, sheet, tile, tileHeight,
  TILE, ROW, FRAME, CARD, SHEET, SHEET_BYTES, CURSOR_PX,
  fitPx, fitBytes, wrapLines, innerWidth, textWidth, utf8Bytes, bar, hint, HINT,
  type Screen, type TextSpec,
} from './layout';
import { toSheets, sheetAt, type Sheet } from './sheets';
import { readingMinutes, type Doc } from '../readwise/client';
import { VIEW_LABELS, EMPTY_MESSAGE, MAX_ROWS, type ViewKey } from '../readwise/views';
import { sectionLabel, EMPTY_DIGEST_MESSAGE } from '../readwise/digest';
import { HOME_VIEWS, type Destination, type Gesture, type HomeItem } from './nav';
import { boardEnabled, APP_NAME } from '../build';

/**
 * Compact rows visible at once. Feed sections use these; article lists use
 * three taller ARTICLE_ROWS cards below.
 */
export const VISIBLE_ROWS = 5;
export const ARTICLE_ROWS = 3;

/** Text width inside a tile or a card: frame width less border, padding and the cursor column. */
const STATS_PX = innerWidth(FRAME.width, TILE.padding, TILE.border);
const TILE_PX = STATS_PX - CURSOR_PX;
const CARD_PX = innerWidth(FRAME.width, CARD.padding, CARD.border) - CURSOR_PX;
/** Inside a sheet, short of the firmware's scrollbar at the right edge. */
const SHEET_PX = SHEET.width - 12;

/**
 * Home: a one-line dashboard, then the doors into reading — one windowed list
 * of five tile slots. The dashboard is slot 0 and scrolls away like any other
 * row once focus moves down, so no tile ever changes size or jumps: the old
 * two-line dashboard vanished on the second swipe and the whole list reflowed
 * 69px upward under the reader's eye (simulator, 2026-10-29).
 *
 * Every value comes from state already held by the app. Home must not fetch the
 * Feed simply to make its dashboard look complete — the Feed row says it has
 * not been opened instead.
 */
export type HomeOverview = {
  /** Articles saved per local day, oldest first, today last. */
  week: number[];
  /** Unstarted articles in New and Later. */
  queued: number;
  /** Their summed reading time, in minutes; unknown lengths count as nothing. */
  queueMinutes: number;
  inProgress: number;
  syncedAt: string | null;
  stale: boolean;
  feed: 'not-opened' | 'loading' | 'error' | { groups: number; articles: number };
  /** How many articles each library door would open onto. */
  counts: Record<ViewKey, number>;
};

/** Tile slots between header and footer: 5 × (35 + 6) = 205px, ending at 243. */
export const HOME_SLOTS = 5;

const BARS = '▁▂▃▄▅▆▇█';

/**
 * One bar per day, on an ABSOLUTE scale: 0 → ▁, 1 → ▂ … 7+ → █. Normalising
 * to the week's maximum made one save a day draw a full block every day,
 * so a quiet week and a busy one looked the same (simulator, 2026-10-29).
 *
 * Spaced: the firmware draws these glyphs edge to edge, and three busy days
 * in a row merged into one slab that read as a single bar. All eight heights
 * render; braille bars (⣀⣤⣶⣿) do not.
 */
export function sparkline(counts: number[]): string {
  return counts.map((c) => BARS[Math.min(BARS.length - 1, Math.max(0, c))]).join(' ');
}

/** "45m", "6h", "2d" — the queue is a size, not an appointment, so coarse is honest. */
export function duration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

const feedCount = (feed: HomeOverview['feed']): string => {
  if (feed === 'not-opened') return 'not sorted yet';
  if (feed === 'loading') return 'sorting…';
  if (feed === 'error') return 'unavailable';
  return `${feed.articles} in ${feed.groups} groups`;
};

/**
 * One glyph per door, from the firmware font. ✓ and the other Dingbats are not
 * in it (even-g2-notes, display.md; pretext measures them at 0px), so marks
 * come from the geometric shapes that are: ◐ is literally "half read".
 */
export const MARK: Record<HomeItem, string> = {
  recent: '●',
  quick: '▷',
  digest: '▽',
  halfread: '◐',
  long: '■',
  surprise: '○',
  ask: '◎',
};

export const HOME_LABELS: Record<HomeItem, string> = {
  recent: VIEW_LABELS.recent,
  quick: `${VIEW_LABELS.quick} <5 min`,
  digest: 'New in Feed',
  halfread: VIEW_LABELS.halfread,
  long: `${VIEW_LABELS.long} 20+ min`,
  surprise: VIEW_LABELS.surprise,
  ask: 'Ask your library',
};

/** A Home row's text, and whether it leads anywhere right now. */
export function homeRow(item: HomeItem, o: HomeOverview): { text: string; quiet: boolean } {
  const label = `${MARK[item]} ${HOME_LABELS[item]}`;
  const row = (value: string, quiet = false) => ({ text: `${label}  ·  ${value}`, quiet });
  if (item === 'ask') return row('speak');
  if (item === 'digest') return row(feedCount(o.feed));
  // Surprise is a draw, not a list; its pool size would read as a promise.
  if (item === 'surprise') return row('pick one');
  const n = o.counts[item];
  // A door with nothing behind it is still a door — but a quiet one, and it
  // says so rather than showing a bare 0 that invites a press onto an empty
  // screen. Lists stop at MAX_ROWS; "20+" rather than a claim of exactly 20.
  if (n === 0) return row('none right now', true);
  return row(n >= MAX_ROWS ? `${MAX_ROWS}+` : `${n}`);
}

export function home(o: HomeOverview, focus = 0, notice: string | null = null): Screen {
  beginScreen();
  const thisWeek = o.week.reduce((a, b) => a + b, 0);
  const stats = fitPx([
    `${sparkline(o.week)}  ${thisWeek} saved`,
    `${o.queued} to read${o.queueMinutes > 0 ? ` ~${duration(o.queueMinutes)}` : ''}`,
    `${o.inProgress} in progress`,
  ].join(' · '), STATS_PX);

  // Slot 0 is the dashboard; the sections follow. The window keeps one row
  // below focus visible as the sign there is more, and never centres focus —
  // that pushed the graph off on the first swipe, before it was read.
  const slots = HOME_VIEWS.length + 1;
  const at = Math.min(Math.max(0, focus), HOME_VIEWS.length - 1) + 1;
  const start = at < HOME_SLOTS - 1 ? 0 : Math.min(slots - HOME_SLOTS, at - (HOME_SLOTS - 2));

  const tiles: TextSpec[] = [];
  for (let slot = start; slot < start + HOME_SLOTS; slot++) {
    const y = ROW.first + (slot - start) * (tileHeight(1) + TILE.gap);
    if (slot === 0) {
      // Never a row, so no cursor column: the dashboard keeps its full width.
      tiles.push(tile('stats', stats, y, 1, false, false, true));
      continue;
    }
    const item = HOME_VIEWS[slot - 1];
    const r = homeRow(item, o);
    tiles.push(tile(`view${slot - 1}`, fitPx(r.text, TILE_PX), y, 1, slot === at, r.quiet));
  }

  return screen('home', [
    // A one-shot notice (a refresh) or a stale library goes in the header, so
    // the glasses cannot imply the data is current while the phone shows an
    // offline banner.
    header(notice
      ? `${APP_NAME}  ·  ${notice}`
      : o.stale
        ? `${APP_NAME}  ·  offline${o.syncedAt ? ` since ${o.syncedAt}` : ''}`
        : APP_NAME),
    ...tiles,
    footer(hint(HINT.swipe, HINT.open, HINT.menu, HINT.exit)),
    captureLayer(),
  ], homeMenu());
}

/**
 * Scroll the focused row into view.
 *
 * A 20-item list against 5 visible rows needs a window, and the window has to
 * follow focus or swiping past row 5 moves a selection nobody can see.
 */
export function windowFor(focus: number, total: number, visible = VISIBLE_ROWS): number {
  if (total <= visible) return 0;
  const maxStart = total - visible;
  // Keep the focused row one from the edge where possible, so there is always
  // a visible hint that the list continues.
  return Math.min(maxStart, Math.max(0, focus - Math.floor(visible / 2)));
}

const LIST_FOOTER = hint(HINT.swipe, HINT.open, HINT.menu, HINT.back);

/** A list of articles: title, publication, reading time. */
export function list(
  view: ViewKey,
  docs: Doc[],
  focus: number,
  notice: string | null = null,
): Screen {
  beginScreen();
  const label = VIEW_LABELS[view];

  if (docs.length === 0) {
    // The way on is one press, not a trip through the menu: Press opens the
    // dependable front door (Recent), or Home when Recent itself is empty.
    const onward = view === 'recent' ? 'Press home' : `Press ${VIEW_LABELS.recent}`;
    return screen('list-empty', [
      header(label),
      body(EMPTY_MESSAGE[view]),
      footer(notice ?? hint(onward, HINT.menu, HINT.back)),
      captureLayer(),
    ], navigationMenu(view));
  }

  const start = windowFor(focus, docs.length, ARTICLE_ROWS);
  const shown = docs.slice(start, start + ARTICLE_ROWS);
  // Position, not count — "3/20" is the only way to know where you are in a
  // windowed list on a display with no scrollbar.
  const counter = `${Math.min(focus + 1, docs.length)}/${docs.length}`;

  return screen('list', [
    header(`${label}  ${counter}`),
    ...shown.map((d, i) =>
      card(`row${i}`, articleCardTitle(d.title), i, start + i === focus)),
    footer(notice ?? LIST_FOOTER),
    captureLayer(),
  ], navigationMenu(view));
}

/**
 * The feed digest — sections, not articles.
 *
 * This is the extra step the feed needs and the library does not. 10,000 items
 * cannot be listed, so the Brain groups the recent intake into a handful of
 * themes and the user enters one. Pressing a row opens its titles.
 *
 * `fromBrain` is surfaced for the same reason `summary` surfaces it: when the
 * board is unreachable these are publications bucketed by name, not a judgement
 * about what is worth reading, and presenting one as the other would be a lie.
 *
 * Rows are the same tiles as Home: three list idioms (tiles, cards, bare rows
 * with a focus border) read as three apps.
 */
export function digest(
  sections: Array<{ name: string; docs: Doc[]; note: string | null }>,
  focus: number,
  fromBrain: boolean,
  loading = false,
  error: string | null = null,
  notice: string | null = null,
): Screen {
  beginScreen();
  if (loading) {
    return screen('digest-loading', [
      header('Feed digest'),
      body('Reading the feed…'),
      footer(notice ?? hint(HINT.menu, HINT.back)),
      captureLayer(),
    ], navigationMenu('digest'));
  }

  if (sections.length === 0) {
    return screen('digest-empty', [
      header('Feed digest'),
      body(error ?? EMPTY_DIGEST_MESSAGE),
      footer(notice ?? (error ? hint('Press retry', HINT.menu, HINT.back) : hint(HINT.menu, HINT.back))),
      captureLayer(),
    ], navigationMenu('digest'));
  }

  const start = windowFor(focus, sections.length);
  const shown = sections.slice(start, start + VISIBLE_ROWS);
  return screen('digest', [
    // "Grouped" rather than a silent downgrade: the header is the only place
    // that can say these sections are publications, not picks.
    header(fromBrain ? 'Feed digest' : 'Feed digest  ·  grouped'),
    ...shown.map((s, i) =>
      tile(`sec${i}`, fitPx(sectionLabel(s), TILE_PX),
        ROW.first + i * (tileHeight(1) + TILE.gap), 1, start + i === focus)),
    footer(notice ?? LIST_FOOTER),
    captureLayer(),
  ], navigationMenu('digest'));
}

/** The titles inside one digest section. */
export function section(
  s: { name: string; docs: Doc[]; note: string | null },
  focus: number,
  notice: string | null = null,
): Screen {
  beginScreen();
  const start = windowFor(focus, s.docs.length, ARTICLE_ROWS);
  const shown = s.docs.slice(start, start + ARTICLE_ROWS);
  const counter = `${Math.min(focus + 1, s.docs.length)}/${s.docs.length}`;
  return screen('section', [
    header(`${fitPx(s.name, 400)}  ${counter}`),
    ...shown.map((d, i) =>
      card(`row${i}`, articleCardTitle(d.title), i, start + i === focus)),
    footer(notice ?? LIST_FOOTER),
    captureLayer(),
  ], navigationMenu('digest'));
}

/**
 * Compact title for a two-line card, wrapped as the firmware will wrap it. A
 * title that needs a third line ends in an ellipsis — the summary always
 * shows the whole title, so the card need not say so.
 */
export function articleCardTitle(title: string): string {
  const lines = wrapLines(title, CARD_PX);
  if (lines.length <= 2) return lines.join('\n');
  return `${lines[0]}\n${fitPx(lines.slice(1).join(' '), CARD_PX)}`;
}

/** Deterministic compact date: locale formatting differs between webviews. */
function savedDate(d: Doc): string | null {
  const date = new Date(d.saved_at);
  if (Number.isNaN(date.getTime())) return null;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getUTCMonth()];
  return `saved ${month} ${date.getUTCDate()}`;
}

/**
 * One line of context under the title: who published it, how long it is, when
 * it was saved. It used to be two framed rows under a header; on a 10-line
 * sheet every line of furniture is a line of the argument not shown.
 *
 * The publication falls back to Reader's `source` ("Reader RSS") only when
 * there is no site name — the source says how it arrived, not who wrote it.
 */
export function metaLine(d: Doc): string {
  const publication = d.site_name ?? d.source ?? null;
  const author = d.author && d.author !== publication ? d.author : null;
  const minutes = readingMinutes(d);
  return [publication, author, minutes ? `${minutes} min` : null, savedDate(d)]
    .filter(Boolean)
    .join(' · ');
}

/** Stable IDs consumed by main.ts when the native SDK menu fires. */
export const MENU = {
  read: 1,
  archive: 2,
  back: 3,
  summary: 4,
  ask: 5,
  refresh: 6,
  summarise: 7,
  recent: 101,
  continue: 102,
  feed: 103,
  surprise: 104,
} as const;

/**
 * Section shortcuts, named exactly as their Home rows are. The menu used to say
 * "Go to recent" for the row called "Recently added"; one thing, one name.
 */
const SECTION_MENU: Array<{ destination: Destination; itemName: string; itemID: number }> = [
  { destination: 'recent', itemName: HOME_LABELS.recent, itemID: MENU.recent },
  { destination: 'halfread', itemName: HOME_LABELS.halfread, itemID: MENU.continue },
  { destination: 'digest', itemName: HOME_LABELS.digest, itemID: MENU.feed },
  { destination: 'surprise', itemName: HOME_LABELS.surprise, itemID: MENU.surprise },
];

const ALWAYS_MENU = [
  // Voice Ask needs the Brain (speech-to-text on the mini): not in a public build.
  ...(boardEnabled() ? [{ itemName: 'Ask your library', itemID: MENU.ask }] : []),
  // The library is served from a 15-minute cache and nothing polls, so this is
  // the one way to see a save made on the phone a moment ago. User-initiated
  // and bounded — not a poll.
  { itemName: 'Refresh library', itemID: MENU.refresh },
];

/**
 * Context actions first, then asking and refreshing, then every section except
 * the one already open. Asking sits on every screen, like the sections: a
 * question can come up anywhere, and the menu is the one way in that is always
 * there.
 */
export function navigationMenu(
  current?: Destination | null,
  actions: Array<{ itemName: string; itemID: number }> = [],
): Array<{ itemName: string; itemID: number }> {
  return [
    ...actions,
    ...ALWAYS_MENU,
    ...SECTION_MENU
      .filter((item) => item.destination !== current)
      .map(({ itemName, itemID }) => ({ itemName, itemID })),
  ];
}

/**
 * Home's menu carries only what Home cannot reach itself. The sections are the
 * rows on the page — repeating them under different names was the one thing
 * the platform guidance says not to do (design-guidelines, "Don't duplicate
 * the page").
 */
export const homeMenu = () => [...ALWAYS_MENU];

/** Pure menu-ID decoder so the SDK callback has no untested routing table. */
export function gestureForMenuItem(itemID: number): Gesture | null {
  switch (itemID) {
    case MENU.read:
    case MENU.summary:
      return 'press';
    case MENU.archive:
      return 'archive';
    case MENU.ask:
      return 'navAsk';
    case MENU.refresh:
      return 'navRefresh';
    case MENU.summarise:
      return 'summarise';
    case MENU.back:
      return 'double';
    case MENU.recent:
      return 'navRecent';
    case MENU.continue:
      return 'navContinue';
    case MENU.feed:
      return 'navFeed';
    case MENU.surprise:
      return 'navSurprise';
    default:
      return null;
  }
}

/**
 * Room kept free on every sheet for the line that closes it: `▼ ━━━━──── 42%`
 * is 31 bytes (the bar's glyphs are three each), the decision lines a little
 * more. The lines that HEAD a sheet are measured, not estimated — see
 * `sheetBudget`.
 */
const MARK_BYTES = 64;

/**
 * Bytes a sheet's text may hold once the lines around it are paid for. The
 * heading and the context line are charged at their actual encoded size: a
 * fixed allowance under-counted a title of narrow three-byte glyphs and the
 * sheet overran the 999-byte container (review of PR #1, 2026-10-29).
 */
const sheetBudget = (headingBytes = 0, contextBytes = 0) => ({
  first: SHEET_BYTES - MARK_BYTES - headingBytes,
  rest: SHEET_BYTES - MARK_BYTES - contextBytes,
});

/** Clamp a route's sheet index into the sheets that exist. */
const clampIndex = (i: number, n: number) => Math.min(Math.max(0, i), n - 1);

/** Closes a sheet that has more after it. Says a swipe will continue. */
const MORE = '▼';

/**
 * Byte ceilings for the title wherever it heads a sheet. Pixels bound what fits
 * on the line; bytes bound what fits in the container, and a narrow glyph can
 * be three bytes. Both apply.
 */
const HEADING_BYTES = 240;
const CONTEXT_TITLE_BYTES = 120;

/** The widest tail a context line can carry; the title gives way to it. */
const CONTEXT_TAIL_MAX = `  ${bar(1)} 100%`;

/**
 * The line at the top of every sheet after the first: which article, and how
 * far in. A resumed reader used to open on bare body text — "In paragraph 19,
 * sentence 1…" — with nothing to say what it was or where, until the last line
 * of the sheet scrolled into view (simulator, 2026-10-29). One of ten lines.
 */
function contextLine(title: string, fraction: number): string {
  const tail = `  ${bar(fraction)} ${Math.round(fraction * 100)}%`;
  const room = fitBytes(fitPx(title, SHEET_PX - textWidth(CONTEXT_TAIL_MAX)), CONTEXT_TITLE_BYTES);
  return `${room}${tail}`;
}

/** What a continued sheet's context line costs, at its longest, newlines included. */
const contextBytes = (title: string) => utf8Bytes(`${contextLine(title, 1)}\n\n`);

export type ArticleOptions = {
  /** One-shot feedback shown above the title, e.g. how the last archive went. */
  notice?: string | null;
  /** Whether archiving moves straight on to another article. Changes the wording. */
  hasNext?: boolean;
};

/**
 * What the front page's text is, when it is not a Brain summary.
 *
 * Opening an article no longer asks the Brain — each summary is a Claude
 * session on the mini (2026-11-19). Until one is asked for, the page shows a
 * free preview and says which kind, so the publisher's blurb is never taken
 * for an AI summary and the opening never for a gist.
 */
export type GistOptions = {
  /** The text is a stand-in, not a summary: whose words it is. */
  preview?: 'publisher' | 'opening';
  /** A summary has been asked for and is on its way. */
  summarising?: boolean;
  /**
   * The menu offers "Summarise". Kept while summarising, so the
   * notice arriving is an in-place upgrade — a changed menu is a rebuild, and
   * a rebuild throws the reader back to the top of the sheet.
   */
  offer?: boolean;
  /**
   * Who writes the summary, for the menu and status line: the reader's own
   * Claude key, or the Brain board. Default 'Brain'.
   */
  ai?: 'Claude' | 'Brain';
};

const PREVIEW_LABEL = { publisher: 'From the publisher', opening: 'Opening' } as const;

/** The line above a preview: whose words, and how to get a summary instead. */
function previewLabel(g: GistOptions): string | null {
  if (!g.preview) return null;
  // □ like every pending notice: the brightness cannot vary within a sheet,
  // so the glyph is what tells a status from the text under it.
  if (g.summarising) return `□ ${g.ai ?? 'Brain'} summarising… · ${PREVIEW_LABEL[g.preview]}`;
  return g.offer ? `${PREVIEW_LABEL[g.preview]} · Tap-hold summarise` : PREVIEW_LABEL[g.preview];
}

const archiveLabel = (hasNext: boolean) => (hasNext ? 'Archive & next' : 'Archive');
const holdHint = (hasNext: boolean) => (hasNext ? 'Hold archive & next' : 'Hold archive');

const articleMenu = (current: Destination | null, first: { itemName: string; itemID: number }, hasNext: boolean) =>
  navigationMenu(current, [
    first,
    { itemName: archiveLabel(hasNext), itemID: MENU.archive },
    { itemName: 'Back', itemID: MENU.back },
  ]);

/**
 * The summary as one document: title, one line of context, the gist.
 *
 * `loading` means `text` is a status line ("Summarising…", or why nothing
 * arrived), not a summary. Otherwise `fromBrain` is surfaced: when the tailnet
 * is down the text is the article's own opening, and presenting an extract as a
 * summary would be a quiet lie about what the user is reading. The label moved
 * from the footer into the text because there is no footer any more.
 */
function summaryDocument(
  d: Doc,
  text: string,
  fromBrain: boolean,
  loading: boolean,
  notice: string | null,
  g: GistOptions = {},
): string {
  const label = previewLabel(g);
  const gist = loading
    ? text || 'Loading…'
    : label ? `${label}\n\n${text}`
      : fromBrain ? text : `Extract · no Brain summary\n\n${text}`;
  const meta = metaLine(d);
  return [notice, d.title, meta || null, '', gist.replace(/\r\n?/g, '\n')]
    .filter((line) => line !== null)
    .join('\n');
}

/** The summary's sheets — exported so nav measures exactly what is drawn. */
export const summarySheets = (
  d: Doc,
  text: string,
  fromBrain: boolean,
  loading = false,
  notice: string | null = null,
  gist: GistOptions = {},
): Sheet[] => toSheets(summaryDocument(d, text, fromBrain, loading, notice, gist), sheetBudget(0, contextBytes(d.title)));

/**
 * The summary: the whole gist on a full-bleed sheet the firmware scrolls.
 *
 * It used to be a header, two framed metadata rows, a four-line box and a
 * footer — five containers of furniture around four lines of argument, turned
 * a page per swipe by a rebuild. Now the text is the screen: ten lines at full
 * width, scrolled a line per swipe by the firmware, continuing onto a second
 * sheet if the gist is long. The title and context scroll away with it; a
 * continued sheet is headed by the title and its place in the gist.
 */
export function summary(
  d: Doc,
  text: string,
  fromBrain: boolean,
  loading = false,
  pageIndex = 0,
  current: Destination | null = 'recent',
  opts: ArticleOptions & GistOptions = {},
): Screen {
  beginScreen();
  const hasNext = opts.hasNext ?? false;
  const sheets = summarySheets(d, text, fromBrain, loading, opts.notice ?? null, opts);
  const i = clampIndex(pageIndex, sheets.length);
  // The last line teaches the two decisions this screen exists for. There are
  // no affordances on a HUD, so an unmentioned gesture is an undiscoverable one.
  const close = i < sheets.length - 1 ? MORE : `▶ Press read · ${holdHint(hasNext)}`;
  const head = i === 0 ? '' : `${contextLine(d.title, i / sheets.length)}\n\n`;
  const read = { itemName: 'Read article', itemID: MENU.read };
  // Summarise leads: Press already reads, so the menu's first item is the one
  // thing this page cannot do with a single gesture.
  const menu = opts.preview && opts.offer
    ? navigationMenu(current, [
      // Just "Summarise": the OS menu cuts its items at about 18 characters —
      // "Summarise with Claude" showed as "Summarise with Cla…" (simulator
      // 0.9.5, 2026-11-21). Who writes it is on the status line instead.
      { itemName: 'Summarise', itemID: MENU.summarise },
      read,
      { itemName: archiveLabel(hasNext), itemID: MENU.archive },
      { itemName: 'Back', itemID: MENU.back },
    ])
    : articleMenu(current, read, hasNext);
  return screen('summary', [sheet(`${head}${sheets[i].text}\n\n${close}`)], menu);
}

/** A title heads the reader's first sheet, capped — in pixels AND bytes — so it cannot eat that sheet. */
const heading = (title: string) => fitBytes(fitPx(title, SHEET_PX * 3), HEADING_BYTES);

/** One-entry memo: the reader re-derives its sheets on every render and gesture. */
let lastReader: { title: string; text: string; sheets: Sheet[] } | null = null;

/**
 * The article as sheets. The heading is charged against the first sheet's
 * budget; offsets are into `text` alone, so progress is a fraction of the
 * article rather than of article-plus-title.
 */
export function readerSheets(d: Pick<Doc, 'title'>, text: string): Sheet[] {
  if (lastReader && lastReader.title === d.title && lastReader.text === text) {
    return lastReader.sheets;
  }
  const sheets = toSheets(text, sheetBudget(utf8Bytes(`${heading(d.title)}\n\n`), contextBytes(d.title)));
  lastReader = { title: d.title, text, sheets };
  return sheets;
}

/** How far through the article a sheet begins, 0..1 — what Readwise stores. */
export const sheetProgress = (sheets: readonly Sheet[], index: number, textLength: number): number =>
  textLength > 0 ? Math.min(1, sheets[clampIndex(index, sheets.length)].start / textLength) : 0;

/** The sheet to reopen at for a stored 0..1 position. */
export const sheetForProgress = (sheets: readonly Sheet[], progress: number, textLength: number): number =>
  sheetAt(sheets, Math.round(Math.min(1, Math.max(0, progress)) * textLength));

/**
 * The reader: the full article, a sheet at a time.
 *
 * The old reader pre-cut seven-line pages because the firmware's own scrolling
 * had nothing to scroll once text was truncated to fit the box. A sheet is not
 * truncated — it is the next ~900 bytes of article, overflowing a ten-line box
 * — so the firmware scrolls it a line per swipe, and only a swipe past either
 * end reaches the reducer to turn the sheet.
 *
 * The first sheet opens with the title; every later one with the title and how
 * far in it starts. Each closes by saying how far through the article its last
 * line is, as a bar and a number: the firmware's scrollbar only knows about the
 * sheet on screen.
 */
export function reader(
  d: Doc,
  text: string,
  pageIndex: number,
  current: Destination | null = 'recent',
  opts: ArticleOptions = {},
): Screen {
  beginScreen();
  const hasNext = opts.hasNext ?? false;
  const sheets = readerSheets(d, text);
  const i = clampIndex(pageIndex, sheets.length);
  const length = Math.max(1, text.length);
  const through = Math.min(0.99, sheets[i].end / length);
  const close = i === sheets.length - 1
    ? `■ End · ${holdHint(hasNext)}`
    : `${MORE} ${bar(through)} ${Math.round(through * 100)}%`;
  const head = i === 0 ? heading(d.title) : contextLine(d.title, sheets[i].start / length);
  return screen(
    'reader',
    [sheet(`${head}\n\n${sheets[i].text}\n\n${close}`)],
    articleMenu(current, { itemName: 'Show summary', itemID: MENU.summary }, hasNext),
  );
}

/**
 * The reader while its text is on the way, or when it will not arrive. A
 * status, not an article: no progress mark and no end mark, because neither
 * would be true.
 */
export function readerStatus(
  d: Doc,
  message: string,
  current: Destination | null = 'recent',
  opts: ArticleOptions = {},
): Screen {
  beginScreen();
  const hasNext = opts.hasNext ?? false;
  return screen(
    'reader',
    [sheet(`${heading(d.title)}\n\n${message}`)],
    articleMenu(current, { itemName: 'Show summary', itemID: MENU.summary }, hasNext),
  );
}

/**
 * Offline / error.
 *
 * `since` names when the cached library was last synced. Showing stale data
 * without saying it is stale is the failure this screen exists to prevent.
 */
export function offline(message: string, since: string | null): Screen {
  beginScreen();
  return screen('offline', [
    header('Offline'),
    body(
      since
        ? `${message}\n\nShowing the library as of ${since}.`
        // Say that nothing is cached, rather than showing a bare error and
        // leaving it ambiguous whether stale data is being displayed.
        : `${message}\n\nNothing cached yet, so there is nothing to show.`,
    ),
    footer(hint('Press retry', HINT.exit)),
    captureLayer(),
  ]);
}

/**
 * First run, before a token exists. Without this the app sent an empty token,
 * got a 401, and greeted a new user with "Offline · Readwise token rejected"
 * — the wrong screen for "you have not set it up yet".
 */
export function welcome(): Screen {
  beginScreen();
  return screen('welcome', [
    header(APP_NAME),
    body([
      'Welcome. One thing to do on the phone first:',
      '',
      'open this app in Even Hub, tap the gear, paste your',
      'Readwise token (readwise.io/access_token) and save.',
      '',
      'Then press here.',
    ].join('\n')),
    footer(hint('Press when saved', HINT.exit)),
    captureLayer(),
  ]);
}

/** Before any fetch has resolved — drawn at once, so the glasses are never blank. */
export function loading(): Screen {
  beginScreen();
  return screen('loading', [
    header(APP_NAME),
    body('Loading your library…'),
    captureLayer(),
  ]);
}

// -------------------------------------------------------------------- asking

/**
 * The asking screens. Each is one full-bleed sheet, like reading: a question
 * and its answer are text to read, not furniture to navigate. None redraws
 * while the mic is open — a rebuild per second for a timer would flicker.
 */
const askMenu = () => navigationMenu(null);

/** The mic is open. Says how to finish, since there is no button to see. */
export function askListening(): Screen {
  beginScreen();
  return screen('ask', [sheet([
    '● Listening…',
    '',
    'Ask your library anything —',
    '“something short about cities”',
    '“what have I read about sleep?”',
    '',
    hint('Pause or Press send', HINT.cancel),
  ].join('\n'))], askMenu());
}

/**
 * Between the mic closing and the answer. Three phases, each a different line,
 * because the whole wait can run to fifteen seconds (README, measured) and one
 * unchanging "Searching…" for all of it reads as a hang. A status sheet is
 * never scrolled, so the rebuild loses nothing.
 */
export function askWorking(
  phase: 'transcribing' | 'searching' | 'answering',
  question: string,
  found = 0,
): Screen {
  beginScreen();
  const status = phase === 'transcribing'
    ? 'Transcribing…'
    // The transcript is shown back so a mishearing is caught before the
    // answer is read as if it were about the right thing.
    : phase === 'searching'
      ? `“${question}”\n\nSearching your library…`
      : `“${question}”\n\nFound ${found} · writing the answer…`;
  return screen('ask', [sheet(`${status}\n\n${HINT.cancel}`)], askMenu());
}

/** An answer's openable documents, with the reason each was chosen. */
export type AnswerPick = { doc: Doc; why: string };

const OPEN_THESE = hint('▶ Press open these', HINT.back);

/**
 * The answer as a document: the question heard, the answer, then the way on
 * and what it points at. The hint sits ABOVE the numbered documents: on a
 * nine-line answer it used to be line eleven, below the fold.
 */
function answerDocument(question: string, answer: string, picks: readonly AnswerPick[]): string {
  const list = picks.map((p, i) =>
    `${i + 1}. ${p.doc.title}${p.why ? ` — ${p.why}` : ''}`);
  return [`“${question}”`, '', answer, ...(list.length ? ['', OPEN_THESE, ...list] : [])].join('\n');
}

export const askAnswerSheets = (question: string, answer: string, picks: readonly AnswerPick[]): Sheet[] =>
  toSheets(answerDocument(question, answer, picks), sheetBudget());

export function askAnswer(
  question: string,
  answer: string,
  picks: readonly AnswerPick[],
  pageIndex = 0,
): Screen {
  beginScreen();
  const sheets = askAnswerSheets(question, answer, picks);
  const i = clampIndex(pageIndex, sheets.length);
  const close = i < sheets.length - 1
    ? `\n\n${MORE}`
    : picks.length ? '' : `\n\n${hint('▶ Press ask again', HINT.back)}`;
  return screen('ask', [sheet(`${sheets[i].text}${close}`)], askMenu());
}

/** The question could not be answered — said plainly, with the way on. */
export function askError(message: string): Screen {
  beginScreen();
  return screen('ask', [sheet(
    `Couldn't answer that.\n\n${fitPx(message, SHEET_PX * 4)}\n\n${hint('▶ Press try again', HINT.back)}`,
  )], askMenu());
}

/** The documents an answer pointed at: title, then why, on each card. */
export function answers(picks: readonly AnswerPick[], focus: number): Screen {
  beginScreen();
  const start = windowFor(focus, picks.length, ARTICLE_ROWS);
  const shown = picks.slice(start, start + ARTICLE_ROWS);
  const counter = `${Math.min(focus + 1, picks.length)}/${picks.length}`;
  return screen('answers', [
    header(`Answer  ${counter}`),
    ...shown.map((p, i) => card(
      `row${i}`,
      // Two lines: what it is, and why the Brain pointed at it — each measured
      // to the card, not cut at a character count.
      `${fitPx(p.doc.title, CARD_PX)}\n${fitPx(p.why || metaLine(p.doc), CARD_PX)}`,
      i,
      start + i === focus,
    )),
    footer(hint(HINT.swipe, HINT.open, HINT.back)),
    captureLayer(),
  ], askMenu());
}
