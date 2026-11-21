import { describe, it, expect } from 'vitest';
import {
  home, list, summary, reader, readerStatus, offline, loading, welcome, windowFor, metaLine, articleCardTitle,
  summarySheets, readerSheets, sheetProgress, sheetForProgress,
  askListening, askWorking, askAnswer, askAnswerSheets, askError, answers,
  digest, section, navigationMenu, homeMenu, gestureForMenuItem, MENU, VISIBLE_ROWS, ARTICLE_ROWS,
  sparkline, duration, homeRow, MARK, HOME_SLOTS,
} from './screens';
import { HOME_VIEWS } from './nav';
import {
  MAX_TEXT_CONTAINERS, CANVAS, ROW, LINE, INK, TEXT, SHEET, SHEET_BYTES, utf8Bytes, FRAME, textWidth,
} from './layout';
import { getAdvW } from '@evenrealities/pretext';
import type { Doc } from '../readwise/client';
import type { Screen } from './layout';

const homeData = (over: Partial<Parameters<typeof home>[0]> = {}): Parameters<typeof home>[0] => ({
  week: [0, 2, 5, 1, 0, 4, 3],
  queued: 42,
  queueMinutes: 610,
  inProgress: 7,
  syncedAt: '10:23',
  stale: false,
  feed: 'not-opened',
  counts: { recent: 20, today: 3, halfread: 7, surprise: 20, quick: 8, long: 14 },
  ...over,
});

const doc = (over: Partial<Doc> & { id: string }): Doc => ({
  title: 'A Long Title About Something', author: 'A. Writer',
  site_name: 'The Guardian', url: 'u', category: 'article', location: 'later',
  reading_progress: 0, reading_time: '7 mins', saved_at: '2026-08-06T10:00:00Z',
  summary: null, ...over,
});

const docs = (n: number) =>
  Array.from({ length: n }, (_, i) => doc({ id: String(i), title: `Article ${i}` }));

/**
 * The invariants the firmware enforces silently. `screen()` already throws on
 * these, so every screen builder is run through this to make the budget a test
 * failure rather than an on-device mystery.
 */
function assertValid(s: Screen) {
  expect(s.containers.length).toBeLessThanOrEqual(MAX_TEXT_CONTAINERS);
  expect(s.containers.filter((c) => c.isEventCapture === 1)).toHaveLength(1);
  for (const c of s.containers) {
    expect(c.containerName.length).toBeLessThanOrEqual(16);
    expect(c.xPosition + c.width).toBeLessThanOrEqual(CANVAS.w);
    expect(c.yPosition + c.height).toBeLessThanOrEqual(CANVAS.h);
    // Border and padding are drawn inside the box: a text area that is not a
    // whole number of firmware lines gets a scrollbar (seen on every 2-line
    // card and on focused digest rows, simulator 2026-10-29).
    if (c.content.trim()) {
      expect((c.height - 2 * (c.paddingLength + c.borderWidth)) % LINE).toBe(0);
    }
  }
  const names = new Set(s.containers.map((c) => c.containerName));
  expect(names.size).toBe(s.containers.length);
}

describe('home', () => {
  const text = (sc: Screen) => sc.containers.map((c) => c.content).join('\n');
  // Focus is the cursor and full brightness — never a border, so a swipe can
  // move it with textContainerUpgrade instead of a page rebuild.
  const focused = (sc: Screen) =>
    sc.containers.filter((c) =>
      c.containerName.startsWith('view') && c.content.startsWith('▶ ') && c.textColor === TEXT.primary);
  const tiles = (sc: Screen) =>
    sc.containers.filter((c) => c.containerName.startsWith('view') || c.containerName === 'stats');

  it('stays within the container budget at every focus', () => {
    for (let f = 0; f < HOME_VIEWS.length; f++) assertValid(home(homeData(), f));
  });

  it('opens on a one-line dashboard: a week of saves as a graph, then the queue', () => {
    const all = text(home(homeData(), 0));
    expect(all).toContain('▁ ▃ ▆ ▂ ▁ ▅ ▄  15 saved · 42 to read ~10h · 7 in progress');
  });

  it('shows the first four sections under the stats, with the first one focused', () => {
    const s = home(homeData(), 0);
    expect(s.containers.filter((c) => c.containerName === 'stats')).toHaveLength(1);
    expect(focused(s).map((c) => c.content)).toEqual(['▶ ● Recently added  ·  20+']);
    expect(text(s)).toContain('     ▷ Quick reads <5 min  ·  8');
    expect(tiles(s)).toHaveLength(HOME_SLOTS);
  });

  // The cursor column is the same width focused or not (25px, measured), so
  // the text never shifts; and every tile keeps the same border, so a focus
  // move differs only in content and brightness — what an upgrade can carry.
  it('moves focus without touching geometry or borders', () => {
    const a = home(homeData(), 0).containers;
    const b = home(homeData(), 1).containers;
    for (let i = 0; i < a.length; i++) {
      const { content: _c, textColor: _t, ...geomA } = a[i];
      const { content: _d, textColor: _u, ...geomB } = b[i];
      expect(geomB).toEqual(geomA);
    }
    for (const t of tiles(home(homeData(), 0))) expect(t.borderWidth).toBe(1);
    expect(textWidth('▶ ')).toBe(textWidth('     '));
  });

  it('keeps the dashboard up while focus is on the first three sections', () => {
    for (const f of [0, 1, 2]) {
      expect(home(homeData(), f).containers.filter((c) => c.containerName === 'stats'))
        .toHaveLength(1);
    }
  });

  it('scrolls the dashboard away as focus moves down to the last sections', () => {
    const s = home(homeData(), HOME_VIEWS.length - 1);
    expect(s.containers.filter((c) => c.containerName === 'stats')).toHaveLength(0);
    expect(focused(s).map((c) => c.content)).toEqual(['▶ ◎ Ask your library  ·  speak']);
    expect(text(s)).toContain('■ Long reads 20+ min  ·  14');
  });

  // The old two-line dashboard vanished on the second swipe and every tile
  // below it jumped 69px. Now every slot is the same height, so a swipe moves
  // the list by exactly one slot, or not at all.
  it('never reflows: every tile sits on the same five slots at every focus', () => {
    const slotsAt = (f: number) => tiles(home(homeData(), f)).map((t) => `${t.yPosition}:${t.height}`);
    const first = slotsAt(0);
    expect(first).toHaveLength(HOME_SLOTS);
    for (let f = 1; f < HOME_VIEWS.length; f++) expect(slotsAt(f)).toEqual(first);
  });

  it('keeps one row below focus visible until the end of the list', () => {
    for (let f = 0; f < HOME_VIEWS.length - 1; f++) {
      const s = home(homeData(), f);
      const names = tiles(s).map((t) => t.containerName);
      expect(names.indexOf(`view${f}`)).toBeLessThan(names.length - 1);
    }
  });

  it('marks every door with a glyph the firmware font has', () => {
    for (const item of HOME_VIEWS) {
      expect(homeRow(item, homeData()).text.startsWith(`${MARK[item]} `)).toBe(true);
      // pretext carries the firmware font's advance widths; a glyph it lacks
      // (✓, the Dingbats) has none, and so is never a mark here.
      expect(getAdvW(MARK[item].codePointAt(0)!)).toBeGreaterThan(0);
    }
    expect(getAdvW('✓'.codePointAt(0)!)).toBe(0);
  });

  // A bare "0" invited a press onto an empty screen at full brightness.
  it('quietens a door with nothing behind it and says so', () => {
    const none = homeData({ counts: { recent: 20, today: 0, halfread: 0, surprise: 0, quick: 0, long: 0 } });
    expect(homeRow('quick', none)).toEqual({ text: '▷ Quick reads <5 min  ·  none right now', quiet: true });
    const s = home(none, 0);
    const quick = s.containers.find((c) => c.containerName === `view${HOME_VIEWS.indexOf('quick')}`)!;
    expect(quick.textColor).toBe(TEXT.quiet);
    // Focus still reads at full brightness, whatever is behind the door.
    const focusedQuick = home(none, HOME_VIEWS.indexOf('quick')).containers
      .find((c) => c.containerName === `view${HOME_VIEWS.indexOf('quick')}`)!;
    expect(focusedQuick.textColor).toBe(TEXT.primary);
  });

  it('carries a one-shot notice in the header', () => {
    expect(home(homeData(), 0, '■ Library refreshed · 41 articles').containers[0].content)
      .toBe('Readwise  ·  ■ Library refreshed · 41 articles');
  });

  it('draws every section as its own bordered tile, spaced apart and clear of the footer', () => {
    for (let f = 0; f < HOME_VIEWS.length; f++) {
      const s = home(homeData(), f);
      const ts = tiles(s);
      const footerTop = s.containers.find((c) => c.containerName === 'footer')!.yPosition;
      for (const t of ts) expect(t.borderWidth).toBeGreaterThanOrEqual(1);
      for (let i = 1; i < ts.length; i++) {
        expect(ts[i].yPosition).toBeGreaterThanOrEqual(ts[i - 1].yPosition + ts[i - 1].height + 4);
      }
      const last = ts[ts.length - 1];
      expect(last.yPosition + last.height).toBeLessThanOrEqual(footerTop);
    }
  });

  // Border and padding are drawn inside the box; an inner height under one
  // firmware line makes the firmware draw a scrollbar in the tile.
  it('leaves each tile a full firmware line per line of text', () => {
    for (const t of [...tiles(home(homeData(), 0)), ...tiles(home(homeData(), 4))]) {
      const lineCount = t.content.split('\n').length;
      expect(t.height - 2 * (t.paddingLength + t.borderWidth)).toBeGreaterThanOrEqual(LINE * lineCount);
    }
  });

  it('never focuses a stat line', () => {
    for (let f = 0; f < HOME_VIEWS.length; f++) {
      expect(focused(home(homeData(), f))).toHaveLength(1);
    }
  });

  // The sections are the rows on the page; repeating them in the menu under
  // other names is what the platform guidance says not to do.
  it('offers only what the page cannot reach through the contextual menu', () => {
    expect(home(homeData()).menuItems?.map((item) => item.itemName))
      .toEqual(['Ask your library', 'Refresh library']);
    expect(homeMenu().map((item) => item.itemID)).toEqual([MENU.ask, MENU.refresh]);
  });

  it('teaches swipe, press, the menu and exit, in the shared grammar', () => {
    expect(text(home(homeData()))).toContain('Swipe · Press open · Tap-hold menu · Double exit');
  });

  // Found in review: with a stale cache AND a failed fetch the glasses showed
  // a normal home screen while the phone showed an offline banner — the two
  // surfaces disagreeing about how current the data was.
  it('marks the header when the library is stale and preserves sync time', () => {
    const s = home(homeData({ stale: true, syncedAt: '18:20' }));
    expect(s.containers[0].content).toBe('Readwise  ·  offline since 18:20');
    assertValid(s);
  });

  it('says nothing extra when the data is current', () => {
    expect(home(homeData()).containers[0].content).toBe('Readwise');
  });

  it('reports every Feed state on its row without causing a load', () => {
    const feedRow = (feed: Parameters<typeof home>[0]['feed']) =>
      text(home(homeData({ feed }), HOME_VIEWS.indexOf('digest')));
    expect(feedRow('not-opened')).toContain('▽ New in Feed  ·  not sorted yet');
    expect(feedRow('loading')).toContain('▽ New in Feed  ·  sorting…');
    expect(feedRow('error')).toContain('▽ New in Feed  ·  unavailable');
    expect(feedRow({ groups: 4, articles: 13 })).toContain('▽ New in Feed  ·  13 in 4 groups');
  });
});

describe('sparkline', () => {
  it('keeps an empty week flat', () => {
    expect(sparkline([0, 0, 0])).toBe('▁ ▁ ▁');
  });

  it('never draws a one-article day as an empty one', () => {
    expect(sparkline([0, 1, 100])).toBe('▁ ▂ █');
  });

  // Normalised to the week's maximum, one save a day drew a full block every
  // day: a quiet week and a busy one looked the same.
  it('is an absolute scale, so a bar means a count', () => {
    expect(sparkline([1, 1, 1])).toBe('▂ ▂ ▂');
    expect(sparkline([1, 2, 3, 4, 5, 6, 7, 8])).toBe('▂ ▃ ▄ ▅ ▆ ▇ █ █');
  });
});

describe('duration', () => {
  it('stays coarse as the queue grows', () => {
    expect(duration(45)).toBe('45m');
    expect(duration(610)).toBe('10h');
    expect(duration(4000)).toBe('3d');
  });
});

describe('list', () => {
  it('stays within budget at every focus position of a full list', () => {
    for (let f = 0; f < 20; f++) assertValid(list('today', docs(20), f));
  });

  it('shows an empty message rather than a blank screen, and the one-press way on', () => {
    const s = list('halfread', [], 0);
    assertValid(s);
    expect(s.containers.map((c) => c.content).join(' ')).toContain('Nothing in progress');
    expect(s.containers.find((c) => c.containerName === 'footer')!.content)
      .toBe('Press Recently added · Tap-hold menu · Double back');
    expect(list('recent', [], 0).containers.find((c) => c.containerName === 'footer')!.content)
      .toBe('Press home · Tap-hold menu · Double back');
  });

  it('teaches the gestures in the shared grammar', () => {
    expect(list('today', docs(2), 0).containers.find((c) => c.containerName === 'footer')!.content)
      .toBe('Swipe · Press open · Tap-hold menu · Double back');
  });

  it('shows position, since there is no scrollbar on a HUD', () => {
    const s = list('today', docs(20), 4);
    expect(s.containers[0].content).toContain('5/20');
  });

  it('renders at most the visible row count', () => {
    const s = list('today', docs(20), 0);
    expect(s.containers.filter((c) => c.containerName.startsWith('row')))
      .toHaveLength(ARTICLE_ROWS);
  });

  it('uses bordered cards across the full content width', () => {
    const rows = list('today', docs(20), 0).containers
      .filter((c) => c.containerName.startsWith('row'));
    expect(rows).toHaveLength(ARTICLE_ROWS);
    for (const c of rows) {
      expect(c.xPosition).toBe(FRAME.x);
      expect(c.width).toBe(FRAME.width);
      expect(c.borderWidth).toBe(1);
    }
  });

  it('wraps titles as the firmware will, and elides a third line', () => {
    const title = 'A deliberately very long article title '.repeat(8);
    const card = articleCardTitle(title);
    const lines = card.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith('…')).toBe(true);
    for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(FRAME.width - 8);
    expect(articleCardTitle('Short title')).toBe('Short title');
  });

  // Rows must clear the footer at y=250, or the last row prints over it.
  it('keeps every row clear of the footer', () => {
    const s = list('today', docs(20), 19);
    for (const c of s.containers.filter((c) => c.containerName.startsWith('row'))) {
      expect(c.yPosition + c.height).toBeLessThanOrEqual(ROW.footer);
    }
  });
});

describe('windowFor', () => {
  it('does not scroll a list that already fits', () => {
    expect(windowFor(2, 4)).toBe(0);
  });

  it('follows focus once the list is longer than the window', () => {
    expect(windowFor(10, 20)).toBe(8);
  });

  it('stops at the end rather than scrolling past it', () => {
    expect(windowFor(19, 20)).toBe(15);
  });

  it('always keeps the focused row inside the window', () => {
    for (let f = 0; f < 20; f++) {
      const start = windowFor(f, 20);
      expect(f).toBeGreaterThanOrEqual(start);
      expect(f).toBeLessThan(start + VISIBLE_ROWS);
    }
  });
});

/**
 * Reading screens are ONE full-bleed text container that holds input, so the
 * firmware scrolls it. No header, no footer, no framed rows — every line of
 * furniture was a line of the article not shown.
 */
function assertSheet(s: Screen) {
  assertValid(s);
  expect(s.containers).toHaveLength(1);
  const [c] = s.containers;
  expect(c.isEventCapture).toBe(1);
  expect(c.xPosition).toBe(SHEET.x);
  expect(c.width).toBe(SHEET.width);
  // Exactly ten firmware lines: no half-drawn eleventh at the bottom.
  expect(c.height).toBe(LINE * SHEET.lines);
  expect(c.paddingLength).toBe(0);
  expect(utf8Bytes(c.content)).toBeLessThanOrEqual(SHEET_BYTES);
}

const content = (s: Screen) => s.containers[0].content;

/** A realistic Brain summary at the 1,400-character ceiling, curly quotes and all. */
const LONG_GIST = Array.from({ length: 14 }, (_, i) =>
  `Point ${i} argues that “attention markets” erode the focus they sell — and says so plainly.`
  + (i % 3 === 2 ? '\n\n' : ' '),
).join('').trim();

const gistSheets = (text: string, title = 'A Long Title About Something') =>
  summarySheets(doc({ id: '1', title }), text, true).length;

describe('summary', () => {
  it('is one full-bleed sheet', () => {
    assertSheet(summary(doc({ id: '1' }), 'The gist of it.', true));
  });

  it('shows the title, one line of context, then the gist', () => {
    const text = content(summary(doc({ id: '1' }), 'The gist of it.', true));
    const [title, meta, blank, gist] = text.split('\n');
    expect(title).toBe('A Long Title About Something');
    expect(meta).toBe('The Guardian · A. Writer · 7 min · saved Aug 6');
    expect(blank).toBe('');
    expect(gist).toBe('The gist of it.');
  });

  // Presenting the article's own opening as a Brain summary would be a quiet
  // lie about what the user is reading.
  it('says so when the text is an extract, not a Brain summary', () => {
    expect(content(summary(doc({ id: '1' }), 'x', true))).not.toContain('Extract');
    expect(content(summary(doc({ id: '1' }), 'x', false))).toContain('Extract');
  });

  it('shows a status instead of an empty sheet while loading', () => {
    expect(content(summary(doc({ id: '1' }), '', true, true))).toContain('Loading');
  });

  it('shows why nothing arrived without calling it an extract', () => {
    const text = content(summary(doc({ id: '1' }), 'Rate limited — try in a minute.', false, true));
    expect(text).toContain('Rate limited');
    expect(text).not.toContain('Extract');
  });

  it('ends by teaching the two decisions it exists for', () => {
    expect(content(summary(doc({ id: '1' }), 'Gist.', true, false, 0, 'recent', { hasNext: true })))
      .toMatch(/▶ Press read · Hold archive & next$/);
    expect(content(summary(doc({ id: '1' }), 'Gist.', true)))
      .toMatch(/▶ Press read · Hold archive$/);
  });

  it('names the move on in the menu only when there is somewhere to go', () => {
    const labels = (hasNext: boolean) =>
      summary(doc({ id: '1' }), 'Gist.', true, false, 0, 'recent', { hasNext })
        .menuItems!.map((m) => m.itemName);
    expect(labels(true)).toContain('Archive & next');
    expect(labels(false)).toContain('Archive');
    expect(labels(false)).not.toContain('Archive & next');
  });

  it('shows a notice above the title, for the screen an archive landed on', () => {
    const text = content(summary(doc({ id: '1' }), 'Gist.', true, false, 0, 'recent',
      { notice: 'Previous article archived' }));
    expect(text.split('\n')[0]).toBe('Previous article archived');
    expect(text.split('\n')[1]).toBe('A Long Title About Something');
  });
});

/**
 * Before a summary is asked for, the page shows a free preview. Each summary is
 * a Claude session on the mini; asking on every open started one per row
 * swiped through (2026-11-19).
 */
describe('summary — a preview until one is asked for', () => {
  const d = doc({ id: '1' });
  const labels = (s: ReturnType<typeof summary>) => s.menuItems!.map((m) => m.itemName);

  // The blurb is Readwise's `summary` field — the publisher's, never an AI one.
  it('names whose words a preview is, and never calls it a summary or an extract', () => {
    const pub = content(summary(d, 'A blurb.', false, false, 0, 'recent', { preview: 'publisher', offer: true }));
    expect(pub).toContain('From the publisher · Tap-hold summarise\n\nA blurb.');
    expect(pub).not.toContain('Extract');
    const open = content(summary(d, 'It began.', false, false, 0, 'recent', { preview: 'opening', offer: true }));
    expect(open).toContain('Opening · Tap-hold summarise\n\nIt began.');
  });

  it('offers Summarise first in the menu, ahead of Read', () => {
    const s = summary(d, 'x', false, false, 0, 'recent', { preview: 'opening', offer: true });
    expect(labels(s).slice(0, 2)).toEqual(['Summarise', 'Read article']);
    expect(s.menuItems![0].itemID).toBe(MENU.summarise);
    expect(gestureForMenuItem(MENU.summarise)).toBe('summarise');
  });

  it('does not offer a summary it already shows, or one with nothing to send', () => {
    expect(labels(summary(d, 'Gist.', true))).not.toContain('Summarise');
    expect(labels(summary(d, 'x', false, false, 0, 'recent', { preview: 'publisher', offer: false })))
      .not.toContain('Summarise');
  });

  // A changed menu is a rebuild, which throws the reader to the top of the sheet.
  it('says a summary is coming without changing the menu', () => {
    const offered = summary(d, 'x', false, false, 0, 'recent', { preview: 'opening', offer: true });
    const pending = summary(d, 'x', false, false, 0, 'recent', { preview: 'opening', offer: true, summarising: true });
    expect(content(pending)).toContain('□ Brain summarising… · Opening');
    expect(content(pending)).not.toContain('Tap-hold summarise');
    expect(pending.menuItems).toEqual(offered.menuItems);
  });

  it('names who will write it: Claude with the reader\'s key, else the Brain', () => {
    const claude = summary(d, 'x', false, false, 0, 'recent', { preview: 'opening', offer: true, ai: 'Claude' });
    // The OS menu truncates at ~18 characters, so the item stays short and
    // the status line names who is writing.
    expect(labels(claude)[0]).toBe('Summarise');
    const pending = summary(d, 'x', false, false, 0, 'recent', { preview: 'opening', offer: true, ai: 'Claude', summarising: true });
    expect(content(pending)).toContain('□ Claude summarising…');
    expect(content(summary(d, 'x', false, false, 0, 'recent', { preview: 'opening', offer: true, summarising: true })))
      .toContain('□ Brain summarising…');
  });

  it('stays inside the menu budget with every section on it', () => {
    const s = summary(d, 'x', false, false, 0, null, { preview: 'opening', offer: true, hasNext: true });
    expect(s.menuItems!.length).toBeLessThanOrEqual(10);
  });

  it('measures the same sheets it draws', () => {
    const long = 'A sentence about something. '.repeat(40);
    const g = { preview: 'opening' as const, offer: true };
    const n = summarySheets(d, long, false, false, null, g).length;
    assertSheet(summary(d, long, false, false, n - 1, 'recent', g));
    expect(content(summary(d, long, false, false, n - 1, 'recent', g))).toMatch(/▶ Press read/);
  });
});

describe('summary sheets', () => {
  it('is one sheet when it fits', () => {
    expect(gistSheets('Two short sentences. That is all there is.')).toBe(1);
  });

  it('continues onto a second sheet at the 1,400-character ceiling', () => {
    expect(gistSheets(LONG_GIST)).toBeGreaterThan(1);
  });

  it('keeps every sheet inside the container limit', () => {
    const d = doc({ id: '1' });
    for (let i = 0; i < gistSheets(LONG_GIST); i++) {
      assertSheet(summary(d, LONG_GIST, true, false, i));
    }
  });

  // The summary used to be CUT at five lines. Every word must be reachable.
  it('loses no text across sheets', () => {
    const d = doc({ id: '1' });
    const seen = Array.from({ length: gistSheets(LONG_GIST) }, (_, i) =>
      content(summary(d, LONG_GIST, true, false, i))).join(' ');
    for (let i = 0; i < 14; i++) expect(seen).toContain(`Point ${i} argues`);
  });

  it('closes a sheet with more after it by saying so', () => {
    const d = doc({ id: '1' });
    expect(content(summary(d, LONG_GIST, true, false, 0))).toMatch(/\n\n▼$/);
    expect(content(summary(d, LONG_GIST, true, false, gistSheets(LONG_GIST) - 1)))
      .toMatch(/▶ Press read/);
  });

  // A continued sheet opened on bare gist with nothing to say which article
  // it was. One line of ten: the title and how far in.
  it('heads a continued sheet with the title and its place in the gist', () => {
    const d = doc({ id: '1' });
    const [head, blank] = content(summary(d, LONG_GIST, true, false, 1)).split('\n');
    expect(head).toMatch(/^A Long Title About Something  [━─]{8} \d+%$/);
    expect(blank).toBe('');
    expect(content(summary(d, LONG_GIST, true, false, 0)).split('\n')[0]).toBe('A Long Title About Something');
  });

  it('clamps a sheet index past the end', () => {
    const d = doc({ id: '1' });
    const last = gistSheets(LONG_GIST) - 1;
    expect(content(summary(d, LONG_GIST, true, false, 99)))
      .toBe(content(summary(d, LONG_GIST, true, false, last)));
  });

  it('shows the complete title, however long', () => {
    const title = 'A complete title that is intentionally much longer than the old fifty two character header limit and must remain reachable';
    const text = content(summary(doc({ id: '1', title }), 'Short summary.', true));
    expect(text).toContain(title);
  });

  // The continued sheet's context line is charged at its real byte size, so a
  // title of narrow three-byte glyphs cannot push a sheet past the container.
  it('stays inside the container on every sheet with a title of three-byte glyphs', () => {
    const narrow = doc({ id: '2', title: '’'.repeat(500) });
    const n = summarySheets(narrow, LONG_GIST, true).length;
    expect(n).toBeGreaterThan(1);
    for (let i = 0; i < n; i++) {
      const s = summary(narrow, LONG_GIST, true, false, i);
      assertSheet(s);
      expect(utf8Bytes(content(s))).toBeLessThanOrEqual(SHEET_BYTES);
    }
  });
});

describe('metaLine', () => {
  it('names the publication, author, length and save date', () => {
    expect(metaLine(doc({ id: '1' }))).toBe('The Guardian · A. Writer · 7 min · saved Aug 6');
  });

  it('falls back to how it arrived only when there is no publication', () => {
    expect(metaLine(doc({ id: '1', site_name: null, source: 'Reader RSS' })))
      .toMatch(/^Reader RSS · /);
    expect(metaLine(doc({ id: '1', source: 'Reader RSS' }))).not.toContain('Reader RSS');
  });

  it('does not repeat an author who is the publication', () => {
    expect(metaLine(doc({ id: '1', author: 'The Guardian' }))).toBe('The Guardian · 7 min · saved Aug 6');
  });

  it('omits what is missing rather than printing separators', () => {
    expect(metaLine(doc({
      id: '1', source: null, author: null, site_name: null, reading_time: null, saved_at: 'nope',
    }))).toBe('');
  });
});

describe('reader', () => {
  /** A realistic long article: ~18k characters of paragraphs with curly quotes. */
  const ARTICLE = Array.from({ length: 60 }, (_, p) =>
    Array.from({ length: 3 + (p % 4) }, (_, s) =>
      `Paragraph ${p} sentence ${s} says “something” about the grid — at length.`).join(' '),
  ).join('\n\n');
  const d = doc({ id: '1' });
  const count = readerSheets(d, ARTICLE).length;

  it('is one full-bleed sheet on every sheet of a long article', () => {
    expect(count).toBeGreaterThan(10);
    for (let i = 0; i < count; i++) assertSheet(reader(d, ARTICLE, i));
  });

  it('heads the first sheet with the title alone', () => {
    expect(content(reader(d, ARTICLE, 0)).startsWith('A Long Title About Something\n\n')).toBe(true);
  });

  // A resumed reader used to open on "In paragraph 19, sentence 1…" with
  // nothing to say what it was or where, until the last line scrolled up.
  it('heads every later sheet with the title and how far in it starts', () => {
    for (let i = 1; i < count; i++) {
      const [head, blank] = content(reader(d, ARTICLE, i)).split('\n');
      expect(head).toMatch(/^A Long Title About Something  [━─]{8} \d+%$/);
      expect(blank).toBe('');
      expect(textWidth(head)).toBeLessThanOrEqual(SHEET.width - 12);
    }
    // A long title gives way to the bar, never the other way round.
    const long = doc({ id: '2', title: 'A title that goes on and on and on and on and on and on and on' });
    const head = content(reader(long, ARTICLE, 1)).split('\n')[0];
    expect(head).toMatch(/…  [━─]{8} \d+%$/);
    expect(textWidth(head)).toBeLessThanOrEqual(SHEET.width - 12);
  });

  it('loses no text across sheets', () => {
    const seen = Array.from({ length: count }, (_, i) => content(reader(d, ARTICLE, i))).join(' ');
    for (let p = 0; p < 60; p++) expect(seen).toContain(`Paragraph ${p} sentence 2 says`);
  });

  // The firmware's scrollbar only knows about the sheet on screen.
  it('closes each sheet with how far through the article it is, rising to the end', () => {
    let last = -1;
    for (let i = 0; i < count - 1; i++) {
      const m = content(reader(d, ARTICLE, i)).match(/\n\n▼ ([━─]{8}) (\d+)%$/);
      expect(m).not.toBeNull();
      const pct = Number(m![2]);
      expect(pct).toBeGreaterThan(last);
      expect(pct).toBeLessThan(100);
      // The bar agrees with the number.
      expect((m![1].match(/━/g) ?? []).length).toBe(Math.round(pct / 100 * 8));
      last = pct;
    }
    expect(content(reader(d, ARTICLE, count - 1))).toMatch(/\n\n■ End · Hold archive$/);
  });

  it('says where hold goes when there is a next article', () => {
    expect(content(reader(d, 'Short.', 0, 'recent', { hasNext: true })))
      .toMatch(/■ End · Hold archive & next$/);
  });

  it('clamps a sheet index past the end', () => {
    expect(content(reader(d, ARTICLE, 9999))).toBe(content(reader(d, ARTICLE, count - 1)));
  });

  it('handles an article short enough for one sheet', () => {
    const s = reader(d, 'Short.', 0);
    assertSheet(s);
    expect(content(s)).toBe('A Long Title About Something\n\nShort.\n\n■ End · Hold archive');
  });

  it('keeps a pathological title from eating the first sheet', () => {
    const title = 'Title '.repeat(200);
    assertSheet(reader(doc({ id: '1', title }), ARTICLE, 0));
  });

  // Pixel width does not bound UTF-8 size: 500 curly quotes are narrow on
  // screen and 1,500 bytes long. Both the heading and the context line are
  // bounded in bytes too, and charged at their real encoded size (PR #1 review).
  it('stays inside the container with a title of narrow three-byte glyphs', () => {
    const narrow = doc({ id: '2', title: '’'.repeat(500) });
    const text = 'word '.repeat(1000);
    const n = readerSheets(narrow, text).length;
    expect(n).toBeGreaterThan(1);
    for (let i = 0; i < n; i++) {
      const s = reader(narrow, text, i);
      assertSheet(s);
      expect(utf8Bytes(content(s))).toBeLessThanOrEqual(SHEET_BYTES);
    }
    assertSheet(readerStatus(narrow, 'Loading the article…'));
  });

  it('keeps a long title of wide glyphs inside the container on every sheet', () => {
    const wide = doc({ id: '3', title: 'W'.repeat(400) });
    const text = 'word '.repeat(1000);
    const n = readerSheets(wide, text).length;
    for (let i = 0; i < n; i++) assertSheet(reader(wide, text, i));
  });
});

describe('reading position ↔ sheet', () => {
  const text = Array.from({ length: 40 }, (_, p) => `Paragraph ${p}. ${'Words go here. '.repeat(12)}`).join('\n\n');
  const sheets = readerSheets(doc({ id: '1' }), text);

  it('round-trips every sheet through the stored fraction', () => {
    for (let i = 0; i < sheets.length; i++) {
      expect(sheetForProgress(sheets, sheetProgress(sheets, i, text.length), text.length)).toBe(i);
    }
  });

  it('starts at 0 and stays inside 0..1', () => {
    expect(sheetProgress(sheets, 0, text.length)).toBe(0);
    expect(sheetProgress(sheets, sheets.length - 1, text.length)).toBeLessThan(1);
    expect(sheetForProgress(sheets, 1, text.length)).toBe(sheets.length - 1);
    expect(sheetForProgress(sheets, -3, text.length)).toBe(0);
  });

  // Positions stored before the switch to sheets were page numbers, so the
  // fraction is what survives any future change to the budget or the title.
  it('lands a fraction inside the sheet holding that part of the text', () => {
    const i = sheetForProgress(sheets, 0.5, text.length);
    expect(sheets[i].start).toBeLessThanOrEqual(text.length / 2);
    expect(sheets[i].end).toBeGreaterThanOrEqual(Math.floor(text.length / 2));
  });
});

describe('menu hints', () => {
  // A plain hold archives the open article; the OS menu is TAP-then-hold. A
  // footer teaching "Hold menu" would teach the gesture that archives.
  it('never teach a plain hold as the way to the menu', () => {
    const sections = [{ name: 'Policy', docs: docs(3), note: null }];
    const screens = [
      home(homeData()), list('recent', docs(5), 0), list('recent', [], 0),
      digest(sections, 0, true), digest([], 0, true), digest([], 0, true, false, 'Rate limited'),
      digest([], 0, true, true), section(sections[0], 0),
    ];
    for (const s of screens) {
      for (const c of s.containers) expect(c.content).not.toMatch(/(^|[^-])Hold menu/);
    }
  });
});

describe('reader status', () => {
  it('shows the title and why, with no progress or end mark', () => {
    const s = readerStatus(doc({ id: '1' }), 'Loading the article…');
    assertSheet(s);
    expect(content(s)).toBe('A Long Title About Something\n\nLoading the article…');
  });
});

describe('offline, loading and welcome', () => {
  it('stay within budget', () => {
    assertValid(offline('No connection to Readwise.', '18:20'));
    assertValid(loading());
    assertValid(welcome());
  });

  // Sending an empty token got a 401 and a new user saw "Offline · Readwise
  // token rejected". First run is not an outage.
  it('welcomes a first run with the phone step and a press to continue', () => {
    const all = welcome().containers.map((c) => c.content).join(' ');
    expect(all).toContain('Welcome');
    expect(all).toContain('readwise.io/access_token');
    expect(all).not.toContain('gear');
    expect(all).not.toContain('Offline');
    expect(welcome().containers.find((c) => c.containerName === 'footer')!.content)
      .toBe('Press when saved · Double exit');
  });

  // Showing stale data without saying it is stale is the failure this
  // screen exists to prevent.
  it('names when the library was last synced', () => {
    const s = offline('No connection to Readwise.', '18:20');
    expect(s.containers.map((c) => c.content).join(' ')).toContain('18:20');
  });

  // Ambiguity is the failure here: a bare error leaves the user unsure whether
  // they are looking at old data or at nothing.
  it('says nothing is cached when there is no cache at all', () => {
    const s = offline('No connection to Readwise.', null);
    const all = s.containers.map((c) => c.content).join(' ');
    expect(all).not.toContain('as of');
    expect(all).toContain('Nothing cached');
  });
});

describe('digest screens', () => {
  const section = (name: string, n: number, note: string | null = null) => ({
    name, note, docs: docs(n),
  });

  it('stays within budget with a full digest', () => {
    assertValid(digest([1, 2, 3, 4, 5, 6].map((i) => section(`S${i}`, 5)), 0, true));
  });

  it('stays within budget at every focus position', () => {
    const secs = [1, 2, 3, 4, 5, 6].map((i) => section(`S${i}`, 5));
    for (let f = 0; f < secs.length; f++) assertValid(digest(secs, f, true));
  });

  it('says when it is grouping rather than triaging', () => {
    // Publications bucketed by name are not a judgement about what to read,
    // and presenting one as the other would be a lie.
    expect(digest([section('Wired', 2)], 0, false).containers[0].content)
      .toContain('grouped');
    expect(digest([section('AI', 2)], 0, true).containers[0].content)
      .not.toContain('grouped');
  });

  it('shows a message rather than a blank screen when the feed is quiet', () => {
    const s = digest([], 0, true);
    assertValid(s);
    expect(s.containers.map((c) => c.content).join(' ')).toContain('Nothing new');
  });

  it('shows a loading state — the digest costs a model turn', () => {
    const s = digest([], 0, true, true);
    assertValid(s);
    expect(s.containers.map((c) => c.content).join(' ')).toContain('Reading the feed');
  });

  it('shows the Feed failure and an explicit retry affordance', () => {
    const s = digest([], 0, false, false, 'No connection to Readwise.');
    expect(s.containers.map((c) => c.content).join(' ')).toContain('No connection');
    expect(s.containers.find((c) => c.containerName === 'footer')!.content)
      .toContain('retry');
  });

  it('keeps every section row clear of the footer', () => {
    const s = digest([1, 2, 3, 4, 5, 6].map((i) => section(`S${i}`, 5)), 5, true);
    for (const c of s.containers.filter((c) => c.containerName.startsWith('sec'))) {
      expect(c.yPosition + c.height).toBeLessThanOrEqual(ROW.footer);
    }
  });

  // Three list idioms — tiles, cards, bare rows with a focus border — read as
  // three apps. Sections are the same tiles as Home.
  it('draws sections as bordered tiles like Home, focus as cursor and brightness', () => {
    const s = digest([section('AI', 2), section('Cities', 3)], 1, true);
    const rows = s.containers.filter((c) => c.containerName.startsWith('sec'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ borderWidth: 1, borderColor: INK.dim, textColor: TEXT.secondary });
    expect(rows[1]).toMatchObject({ borderWidth: 1, borderColor: INK.dim, textColor: TEXT.primary });
    expect(rows[1].content.startsWith('▶ ')).toBe(true);
    expect(rows[0].content.startsWith('     ')).toBe(true);
    const h = home(homeData(), 0).containers.find((c) => c.containerName === 'view0')!;
    expect(rows[1].height).toBe(h.height);
    expect(rows[1].yPosition - rows[0].yPosition).toBe(h.height + 6);
    expect(rows[0].yPosition).toBe(ROW.first);
  });
});

describe('section screen', () => {
  it('stays within budget and shows position', () => {
    const s = section({ name: 'AI policy', docs: docs(5), note: null }, 2);
    assertValid(s);
    expect(s.containers[0].content).toContain('3/5');
  });

  it('keeps every row clear of the footer', () => {
    const s = section({ name: 'AI', docs: docs(5), note: null }, 4);
    for (const c of s.containers.filter((c) => c.containerName.startsWith('row'))) {
      expect(c.yPosition + c.height).toBeLessThanOrEqual(ROW.footer);
    }
  });
});

describe('section navigation menu', () => {
  it('offers asking and refreshing first, then orders predictable reading before discovery', () => {
    expect(navigationMenu().map((item) => item.itemID))
      .toEqual([MENU.ask, MENU.refresh, MENU.recent, MENU.continue, MENU.feed, MENU.surprise]);
  });

  // One thing, one name: the menu said "Go to recent" for the row called
  // "Recently added".
  it('names sections exactly as their Home rows are named', () => {
    const names = navigationMenu().map((item) => item.itemName);
    expect(names).toEqual([
      'Ask your library', 'Refresh library', 'Recently added', 'Continue reading', 'New in Feed', 'Surprise me',
    ]);
    for (const n of names) expect(utf8Bytes(n)).toBeLessThanOrEqual(32);
  });

  it('keeps the home overview within budget across Feed states', () => {
    for (const feed of ['not-opened', 'loading', 'error'] as const) {
      assertValid(home(homeData({ feed })));
    }
    assertValid(home(homeData({ feed: { groups: 6, articles: 30 } })));
  });

  it('omits the current section and puts context actions first', () => {
    const menu = navigationMenu('digest', [{ itemName: 'Archive', itemID: MENU.archive }]);
    expect(menu[0]).toEqual({ itemName: 'Archive', itemID: MENU.archive });
    expect(menu.map((item) => item.itemID)).not.toContain(MENU.feed);
  });

  it('maps every SDK menu ID to the intended reducer gesture', () => {
    expect(gestureForMenuItem(MENU.read)).toBe('press');
    expect(gestureForMenuItem(MENU.summary)).toBe('press');
    expect(gestureForMenuItem(MENU.archive)).toBe('archive');
    expect(gestureForMenuItem(MENU.back)).toBe('double');
    expect(gestureForMenuItem(MENU.recent)).toBe('navRecent');
    expect(gestureForMenuItem(MENU.continue)).toBe('navContinue');
    expect(gestureForMenuItem(MENU.feed)).toBe('navFeed');
    expect(gestureForMenuItem(MENU.surprise)).toBe('navSurprise');
    expect(gestureForMenuItem(MENU.ask)).toBe('navAsk');
    expect(gestureForMenuItem(MENU.refresh)).toBe('navRefresh');
    expect(gestureForMenuItem(999)).toBeNull();
  });

  it('is carried through lists, digests, article detail and reader rebuilds', () => {
    const screens = [
      list('recent', docs(2), 0),
      digest([{ name: 'AI', docs: docs(2), note: null }], 0, true),
      summary(doc({ id: '1' }), 'Summary', true),
      reader(doc({ id: '1' }), 'Body', 0),
    ];
    for (const s of screens) expect(s.menuItems?.length).toBeGreaterThan(0);
  });
});


describe('asking screens', () => {
  const picks = [
    { doc: doc({ id: 'p1', title: 'Explaining the Housing Crisis' }), why: 'cities as flows' },
    { doc: doc({ id: 'p2', title: 'The vision of solarpunk' }), why: '' },
  ];

  it('are full-bleed sheets carrying the ask menu', () => {
    for (const s of [askListening(), askWorking('transcribing', ''), askWorking('searching', 'q'),
      askAnswer('q', 'a', picks), askError('The Brain took too long.')]) {
      assertSheet(s);
      expect(s.menuItems?.[0].itemName).toBe('Ask your library');
    }
  });

  it('tells a listener how to finish, since there is nothing to press on screen', () => {
    expect(content(askListening())).toMatch(/Pause or Press send · Double cancel$/);
  });

  // Showing the transcript back catches a mishearing before the answer is
  // read as though it were about the right thing.
  it('shows what was heard while searching', () => {
    expect(content(askWorking('searching', 'something about cities')))
      .toContain('“something about cities”');
  });

  // The whole wait can run to fifteen seconds; one unchanging "Searching…"
  // for all of it read as a hang.
  it('says the search is done while the answer is being written', () => {
    const text = content(askWorking('answering', 'something about cities', 2));
    expect(text).toContain('“something about cities”');
    expect(text).toContain('Found 2 · writing the answer…');
    expect(text).toMatch(/Double cancel$/);
    assertSheet(askWorking('answering', 'q', 0));
  });

  // The hint sits ABOVE the documents: on a nine-line answer it was line
  // eleven, below the fold.
  it('answers with the question, the answer, the way on, then what it points at', () => {
    const text = content(askAnswer('something about cities', 'Two pieces fit.', picks));
    const lines = text.split('\n');
    expect(lines[0]).toBe('“something about cities”');
    expect(lines[2]).toBe('Two pieces fit.');
    expect(lines[4]).toBe('▶ Press open these · Double back');
    expect(lines[5]).toBe('1. Explaining the Housing Crisis — cities as flows');
    expect(lines[6]).toBe('2. The vision of solarpunk');
    expect(lines).toHaveLength(7);
  });

  it('offers to ask again when the answer points at nothing', () => {
    expect(content(askAnswer('q', 'Nothing in your library covers that.', [])))
      .toMatch(/▶ Press ask again · Double back$/);
  });

  it('runs a long answer onto more sheets, losing nothing', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Sentence ${i} of a long answer.`).join(' ');
    const n = askAnswerSheets('q', long, picks).length;
    expect(n).toBeGreaterThan(1);
    const seen = Array.from({ length: n }, (_, i) => content(askAnswer('q', long, picks, i))).join(' ');
    for (let i = 0; i < 40; i++) expect(seen).toContain(`Sentence ${i} of`);
  });

  it('says why an answer failed, and the way on', () => {
    expect(content(askError('Cannot reach the Brain — is the Mac mini on the tailnet?')))
      .toMatch(/tailnet\?\n\n▶ Press try again · Double back$/);
  });

  it('lists the answer\'s documents as cards: what it is, then why', () => {
    const s = answers(picks, 1);
    assertValid(s);
    expect(s.containers[0].content).toBe('Answer  2/2');
    const cards = s.containers.filter((c) => c.containerName.startsWith('row'));
    expect(cards[0].content).toBe('     Explaining the Housing Crisis\n     cities as flows');
    // No reason given: the card falls back to where it is from. Focused: the
    // cursor on the first line, the pad on the second, full brightness.
    expect(cards[1].content).toMatch(/^▶ The vision of solarpunk\n     The Guardian/);
    expect(cards[1].textColor).toBe(TEXT.primary);
  });

  // Titles were cut at 48 characters with 60px to spare on the card.
  it('measures a long title to the card rather than counting characters', () => {
    const long = [{ doc: doc({ id: 'p', title: 'The grid cannot carry the data centres we keep approving' }), why: 'x' }];
    const [title] = answers(long, 0).containers.find((c) => c.containerName === 'row0')!.content.split('\n');
    expect(title).toBe('▶ The grid cannot carry the data centres we keep approving');
  });
});

/**
 * The Even OS contextual menu cuts item names at about 18 characters:
 * "Summarise with Claude" rendered as "Summarise with Cla…" (simulator 0.9.5,
 * 2026-11-21). Every label the app can put in a menu must fit.
 */
describe('menu labels fit the OS menu', () => {
  it('every item, on every screen that has a menu, is at most 18 characters', () => {
    const d = doc({ id: '1' });
    const menus = [
      homeMenu(),
      navigationMenu(null),
      summary(d, 'x', false, false, 0, null, { preview: 'opening', offer: true, hasNext: true }).menuItems!,
      summary(d, 'Gist.', true, false, 0, null, { hasNext: true }).menuItems!,
      reader(d, 'Body', 0, null, { hasNext: true }).menuItems!,
    ];
    for (const item of menus.flat()) expect(item.itemName.length, item.itemName).toBeLessThanOrEqual(18);
  });
});
