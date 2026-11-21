/**
 * Glasses layout primitives for the 576×288 G2 canvas.
 *
 * These are PURE — they return plain container specs, never touch the bridge.
 * That is deliberate: every screen can then be unit-tested and rendered in the
 * simulator without hardware, and the budget can be asserted in tests rather
 * than discovered on-device.
 *
 * Hard limits (everything-evenhub glasses-ui skill; hub.evenrealities.com
 * /docs/build/display):
 *   576×288 · 4-bit = 16 shades of GREEN (0–15) · max 8 text/list + 4 image
 *   exactly one isEventCapture:1 · no fill, border is the only decoration
 *   ONE firmware font · text brightness 0–4 (SDK 0.0.14+)
 *   left/top aligned only · containerName max 16 chars
 *
 * No image containers. They are allowed (4 per page, 20–288 × 20–144 px) but
 * every one is a placeholder after each rebuild and needs its own
 * `updateImageRawData` — a BLE frame of 0.5–2 s (glasses-ui "Best Practices").
 * Every focus move here is a rebuild, so a row of icons would cost a visible
 * pause per swipe. Marks are glyphs from the firmware font instead (2026-10-29).
 */

import { getTextWidth } from '@evenrealities/pretext';

export const CANVAS = { w: 576, h: 288 } as const;
export const MAX_TEXT_CONTAINERS = 8;
export const MAX_IMAGE_CONTAINERS = 4;

/**
 * Pixel width of a string in the firmware font — `@evenrealities/pretext`
 * carries the LVGL font's advance widths and kerning (font-measurement skill).
 * Glyphs the font lacks measure 0, which is also how the firmware draws them.
 */
export const textWidth = (s: string): number => getTextWidth(s);

/**
 * Border greys. Text hierarchy is separate, via TEXT (SDK 0.0.14+).
 */
export const INK = {
  /** Focused/selected border. */
  bright: 15,
  /** Default border. */
  mid: 8,
  /** Recessive border — unfocused tiles and cards. */
  dim: 5,
} as const;

/**
 * Text brightness, 0–4 (SDK 0.0.14+, Even App 2.2.9+). Hierarchy, not
 * decoration: the header and footer are furniture, a door with nothing behind
 * it is quiet. Simulator 0.9 renders the levels; their legibility on the
 * glasses is NOT photometrically matched (glasses-ui skill), so nothing that
 * must be read sits below `secondary`.
 */
export const TEXT = {
  primary: 4,
  secondary: 3,
  furniture: 2,
  quiet: 1,
  hidden: 0,
} as const;

/**
 * Firmware line height is **27px, fixed**. Any container shorter than that
 * clips its glyphs — which is exactly what a 24px header did on the simulator:
 * the tops and bottoms of letters were sliced off.
 */
export const LINE = 27;

/**
 * The height of a box whose text area holds exactly `n` lines.
 *
 * The firmware draws border AND padding inside the container (font-measurement
 * skill, "Accounting for Padding and Borders"), so a 2-line card at
 * 54 + 2×3 padding with a 1px border left 52px for 54px of text and the
 * firmware answered with a scrollbar on every card — seen in the simulator on
 * article lists, Feed sections and the Answer list (2026-10-29). The border
 * is part of the arithmetic, not an afterthought.
 */
export const boxHeight = (n: number, padding: number, border = 0) =>
  LINE * n + 2 * (padding + border);

/** Unbordered boxes — header, footer, body. */
export const lines = (n: number, padding = 4) => boxHeight(n, padding, 0);

/** Header and footer are fixed furniture; content lives between them. */
export const ROW = { header: 4, first: 44, footer: 250 } as const;
export const FRAME = { x: 8, width: 560 } as const;

export type TextSpec = {
  kind: 'text';
  xPosition: number;
  yPosition: number;
  width: number;
  height: number;
  containerID: number;
  containerName: string;
  content: string;
  borderWidth: number;
  borderColor: number;
  borderRadius: number;
  paddingLength: number;
  isEventCapture: 0 | 1;
  /** 0–4 brightness. This is hierarchy, not decoration. */
  textColor: number;
};

export type MenuItemSpec = { itemName: string; itemID: number };

export type Screen = {
  /** For tests and the simulator harness. */
  name: string;
  containers: TextSpec[];
  /** Native first-level menu shown by the glasses OS on sustained press. */
  menuItems?: MenuItemSpec[];
};

let nextId = 1;
const resetIds = () => { nextId = 1; };

function text(spec: Partial<TextSpec> & { containerName: string; content: string }): TextSpec {
  if (spec.containerName.length > 16) {
    throw new Error(`containerName "${spec.containerName}" exceeds 16 chars`);
  }
  return {
    kind: 'text',
    xPosition: 0,
    yPosition: 0,
    width: CANVAS.w,
    height: 28,
    containerID: nextId++,
    borderWidth: 0,
    borderColor: INK.mid,
    borderRadius: 0,
    paddingLength: 4,
    isEventCapture: 0,
    textColor: TEXT.primary,
    ...spec,
  } as TextSpec;
}

/** Top line: where you are. Dim, because it is furniture, not content. */
export const header = (content: string): TextSpec =>
  text({ containerName: 'header', content, xPosition: FRAME.x, yPosition: ROW.header, width: FRAME.width, height: lines(1), borderColor: INK.mid, textColor: TEXT.furniture });

/**
 * Bottom line: what the gestures do here.
 *
 * Always present. There are only four gestures and no affordances on a HUD —
 * without this line the user has to remember what each screen accepts.
 */
export const footer = (content: string): TextSpec =>
  text({ containerName: 'footer', content, xPosition: FRAME.x, yPosition: ROW.footer, width: FRAME.width, height: lines(1), borderColor: INK.mid, textColor: TEXT.quiet });

/**
 * One grammar for every footer and every closing line: gesture, then the verb,
 * joined by middle dots, no colons. Five screens had five dialects
 * ("Press open", "Press: read", "Press to send now", "Tap-hold menu: sections")
 * and on a HUD the footer is the only affordance there is. The menu is
 * TAP-then-hold: a plain hold archives, so "Hold menu" is never written.
 */
export const HINT = {
  swipe: 'Swipe',
  open: 'Press open',
  menu: 'Tap-hold menu',
  back: 'Double back',
  exit: 'Double exit',
  cancel: 'Double cancel',
} as const;

export const hint = (...parts: string[]): string => parts.join(' · ');

/**
 * Focus is CONTENT and BRIGHTNESS, never geometry or border: a `▶` cursor on
 * the focused row (the documented "fake button" pattern — design-guidelines,
 * "Fake buttons") at full brightness, the rest a step dimmer behind a pad of
 * the cursor's exact width (25px in the firmware font, measured with pretext)
 * so text never shifts. `textContainerUpgrade` can change only `content` and
 * `textColor` (SDK 0.0.16 typings), so a focus expressed this way moves
 * flicker-free in place; a border or padding change forces a page rebuild,
 * which flickers on hardware (glasses-ui skill). The 2px bright border the
 * tiles used before was a rebuild per swipe.
 */
export const CURSOR = '▶ ';
export const CURSOR_PX = textWidth(CURSOR);
const CURSOR_PAD = ' '.repeat(Math.round(CURSOR_PX / textWidth(' ')));

/** Prefix every line so a focused and an unfocused row align; the cursor on the first. */
export const cursor = (content: string, focused: boolean): string =>
  content.split('\n').map((line, i) => `${focused && i === 0 ? CURSOR : CURSOR_PAD}${line}`).join('\n');

/**
 * A bordered tile, sized so its text area holds exactly `n` lines. Every tile
 * keeps the same dim border so each section reads as its own block; `quiet`
 * dims the text for a tile that leads nowhere right now; `plain` drops the
 * cursor column for a tile that is never a row (the dashboard).
 */
export const TILE = { padding: 3, border: 1, gap: 6 } as const;
export const tileHeight = (n: number) => boxHeight(n, TILE.padding, TILE.border);

export const tile = (
  name: string,
  content: string,
  y: number,
  n: number,
  focused: boolean,
  quiet = false,
  plain = false,
): TextSpec =>
  text({
    containerName: name,
    content: plain ? content : cursor(content, focused),
    xPosition: FRAME.x,
    yPosition: y,
    width: FRAME.width,
    height: tileHeight(n),
    paddingLength: TILE.padding,
    borderWidth: TILE.border,
    borderColor: INK.dim,
    borderRadius: 6,
    textColor: focused ? TEXT.primary : quiet ? TEXT.quiet : TEXT.secondary,
  });

/** Two-line, full-width article card. Three fit between header and footer. */
export const CARD = { padding: 3, border: 1, pitch: 66 } as const;
export const cardHeight = boxHeight(2, CARD.padding, CARD.border);

export const card = (
  name: string,
  content: string,
  index: number,
  focused: boolean,
): TextSpec =>
  text({
    containerName: name,
    content: cursor(content, focused),
    xPosition: FRAME.x,
    yPosition: ROW.first + index * CARD.pitch,
    width: FRAME.width,
    height: cardHeight,
    paddingLength: CARD.padding,
    borderWidth: CARD.border,
    borderColor: INK.dim,
    borderRadius: 6,
    textColor: focused ? TEXT.primary : TEXT.secondary,
  });

/**
 * Most bytes any one text container may carry.
 *
 * The docs say 1,000 characters for create/rebuild and 2,000 for
 * `textContainerUpgrade`. Simulator 0.9.5 enforces neither: its release notes
 * call 999 BYTES the firmware limit, and an upgrade of 1,393 bytes returned
 * false (2026-09-24). Bytes, not characters — curly quotes and em dashes are
 * three bytes each in UTF-8, and articles are full of them.
 */
export const MAX_CONTENT_BYTES = 999;

/** UTF-8 length, which is what the container limit counts. */
export const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

/**
 * The reading sheet: one full-bleed text container that the FIRMWARE scrolls.
 *
 * Verified in simulator 0.9.5 on 2026-09-24 against a probe page:
 *   - an overflowing capture text container scrolls natively, one 27px line
 *     per swipe, and draws its own scrollbar;
 *   - no event reaches the app while it scrolls. SCROLL_BOTTOM arrives only for
 *     a swipe made when the last line is ALREADY on screen (SCROLL_TOP likewise
 *     at the top), so every line has been seen before the app is told;
 *   - rebuilds and `textContainerUpgrade` both reset the scroll to the top;
 *   - wrapped text stops short of the scrollbar.
 *
 * Exactly ten lines tall with zero padding: a scrolled line then aligns with
 * the top edge instead of leaving a sliver of the previous line's descenders,
 * and no eleventh line is ever drawn half-cut at the bottom.
 *
 * Starts at x=12 — the same left edge as list text (frame 8 + padding 4, or
 * tile 8 + border 1 + padding 3) — so entering a sheet no longer shifts the
 * text 8px left (seen in the simulator, 2026-10-29).
 */
export const SHEET = { x: 12, y: 9, width: 560, lines: 10 } as const;

/**
 * Bytes per sheet. Under MAX_CONTENT_BYTES with headroom, because a rejected
 * rebuild leaves the previous screen up and the reader stuck on it.
 */
export const SHEET_BYTES = 960;

/** The one container on a reading screen. It owns input so the firmware scrolls it. */
export const sheet = (content: string): TextSpec =>
  text({
    containerName: 'sheet',
    content,
    xPosition: SHEET.x,
    yPosition: SHEET.y,
    width: SHEET.width,
    height: LINE * SHEET.lines,
    paddingLength: 0,
    isEventCapture: 1,
  });

/** The body container's geometry. */
export const BODY = { x: FRAME.x, width: FRAME.width, padding: 4 } as const;

/** Full-width body for status screens — empty list, offline, loading. Never captures. */
export const body = (content: string): TextSpec =>
  text({
    containerName: 'body',
    content,
    // Tight margins. The SDK exposes NO font size, so the only way to fit more
    // words on a line is to give the text more width.
    xPosition: BODY.x,
    yPosition: ROW.first,
    width: BODY.width,
    // Seven lines plus its own padding. It used to claim lines(7, 8) while
    // padding 4 — a 197px text area, 8px over seven lines — which the new
    // screen() guard was the first thing to notice (2026-10-29).
    height: lines(7, BODY.padding),
    paddingLength: BODY.padding,
  });

/**
 * Invisible full-canvas capture layer.
 *
 * Used on list screens where no single container should own input. Content is
 * a space rather than empty — an empty container can be dropped by the firmware.
 */
export const captureLayer = (): TextSpec =>
  text({
    containerName: 'capture',
    content: ' ',
    xPosition: 0,
    yPosition: 0,
    width: CANVAS.w,
    height: CANVAS.h,
    isEventCapture: 1,
    textColor: TEXT.hidden,
  });

/**
 * Assemble and VALIDATE a screen.
 *
 * Throws rather than letting the firmware fail opaquely: a page over budget,
 * with the wrong number of capture containers, off the canvas, or with a text
 * area that is not a whole number of firmware lines is a bug we can catch in a
 * test. The last rule is the one that would have caught the card scrollbar:
 * border and padding are drawn inside the box, so `height − 2(padding +
 * border)` must be a multiple of 27 for every box that shows text.
 */
export function screen(name: string, containers: TextSpec[], menuItems?: MenuItemSpec[]): Screen {
  const captures = containers.filter((c) => c.isEventCapture === 1).length;
  if (captures !== 1) {
    throw new Error(`screen "${name}": exactly one container must have isEventCapture:1, found ${captures}`);
  }
  if (containers.length > MAX_TEXT_CONTAINERS) {
    throw new Error(`screen "${name}": ${containers.length} text containers exceeds the max of ${MAX_TEXT_CONTAINERS}`);
  }
  const names = new Set(containers.map((c) => c.containerName));
  if (names.size !== containers.length) {
    throw new Error(`screen "${name}": duplicate containerName`);
  }
  for (const c of containers) {
    if (utf8Bytes(c.content) > MAX_CONTENT_BYTES) {
      throw new Error(`screen "${name}": "${c.containerName}" exceeds ${MAX_CONTENT_BYTES} bytes`);
    }
    if (c.xPosition < 0 || c.yPosition < 0 || c.xPosition + c.width > CANVAS.w || c.yPosition + c.height > CANVAS.h) {
      throw new Error(`screen "${name}": "${c.containerName}" leaves the canvas`);
    }
    // A blank capture layer draws nothing, so its height is free.
    if (c.content.trim() === '') continue;
    const inner = c.height - 2 * (c.paddingLength + c.borderWidth);
    if (inner < LINE || inner % LINE !== 0) {
      throw new Error(`screen "${name}": "${c.containerName}" text area is ${inner}px, not a multiple of ${LINE} — the firmware will draw a scrollbar`);
    }
  }
  if (menuItems) {
    if (menuItems.length > 10) throw new Error(`screen "${name}": menu exceeds 10 items`);
    const ids = new Set(menuItems.map((item) => item.itemID));
    if (ids.size !== menuItems.length || menuItems.some((item) => item.itemID <= 0)) {
      throw new Error(`screen "${name}": menu IDs must be unique and non-zero`);
    }
    if (menuItems.some((item) => new TextEncoder().encode(item.itemName).length > 32)) {
      throw new Error(`screen "${name}": menu label exceeds 32 UTF-8 bytes`);
    }
  }
  return { name, containers, ...(menuItems?.length ? { menuItems } : {}) };
}

/** Call before building each screen so IDs stay stable and 1-based per page. */
export const beginScreen = resetIds;


/** The pixel width inside a box: what text has to fit into. */
export const innerWidth = (width: number, padding: number, border = 0) =>
  width - 2 * (padding + border);

/**
 * Truncate to fit a pixel width, on a word boundary where possible.
 *
 * Measured, not counted: a character cap of 52 cut "we keep approving" to
 * "we keep…" on a card with 60px to spare, and let a line of wide capitals
 * run past the border. Past the width the firmware clips mid-word, which
 * reads as a bug rather than as elision.
 */
export function fitPx(s: string, maxPx: number): string {
  if (textWidth(s) <= maxPx) return s;
  const mark = '…';
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (textWidth(s.slice(0, mid).trimEnd() + mark) <= maxPx) lo = mid; else hi = mid - 1;
  }
  const cut = s.slice(0, lo);
  const sp = cut.lastIndexOf(' ');
  return (sp > lo * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + mark;
}

/**
 * Truncate to a UTF-8 byte budget, on a word boundary where possible.
 *
 * Pixel width does not bound size: a title of 500 curly quotes is narrow on
 * screen and 1,500 bytes long, and a heading sized by pixels alone pushed a
 * sheet past the 999-byte container limit (review of PR #1, 2026-10-29).
 * Anything that is charged against a sheet's budget is bounded both ways.
 */
export function fitBytes(s: string, maxBytes: number): string {
  if (utf8Bytes(s) <= maxBytes) return s;
  const mark = '…';
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (utf8Bytes(s.slice(0, mid).trimEnd() + mark) <= maxBytes) lo = mid; else hi = mid - 1;
  }
  const cut = s.slice(0, lo);
  const sp = cut.lastIndexOf(' ');
  return (sp > lo * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + mark;
}

/**
 * Wrap text into rendered lines, greedily on word boundaries, measured in the
 * firmware font — so a line count here matches the line count on the glass.
 *
 * Measuring the real wrap is the point. A flat character cap cannot be right
 * for text containing newlines: `fit(x, 360)` assumed 360 characters wraps to 7
 * lines, true only if every line runs full width. A real card body has short
 * lines and blank lines between paragraphs, so 351 characters wrapped to ELEVEN
 * lines, overflowed its box and clipped mid-glyph. The firmware does not clip
 * to the container — anything past the last line prints over what is below it.
 */
export function wrapLines(s: string, innerPx: number): string[] {
  const out: string[] = [];
  for (const para of s.split('\n')) {
    if (!para.trim()) { out.push(''); continue; }
    let line = '';
    // Filter empties: runs of spaces (and a trailing space) would otherwise
    // become empty "words" that pad a line with whitespace it cannot use.
    for (const word of para.split(' ').filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate) <= innerPx) { line = candidate; continue; }
      if (line) out.push(line);
      line = word;
    }
    if (line) out.push(line);
  }
  return out;
}

/**
 * A progress bar the font can draw: `━` filled, `─` empty (the documented
 * pattern — design-guidelines skill, "Progress bars"). Eight cells is coarse
 * enough to read at a glance and 24 bytes at most.
 */
export const BAR_CELLS = 8;
export function bar(fraction: number, cells = BAR_CELLS): string {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * cells);
  return '━'.repeat(filled) + '─'.repeat(cells - filled);
}
