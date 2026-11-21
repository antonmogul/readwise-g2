/**
 * Long text → sheets the firmware can scroll.
 *
 * A reading screen is one full-bleed text container (`layout.ts:sheet`). The
 * firmware scrolls it line by line on its own and only tells the app when a
 * swipe runs past either end — so the app's job is no longer to measure lines
 * and cut pages, but to hand over the next piece of text at the boundary.
 *
 * The piece is bounded by BYTES, not lines: a container rejects anything over
 * 999 UTF-8 bytes (see `MAX_CONTENT_BYTES`). Within that budget the cut is
 * placed where a reader would choose to pause — a paragraph break, then a
 * sentence end, then a word boundary — because the swap to a new sheet is a
 * page turn, and a page turn mid-word reads as a glitch.
 *
 * Offsets into the source text are kept alongside each sheet. They are what
 * makes a reading position durable: a sheet index changes whenever the budget
 * or the title changes, a character offset does not.
 */

import { utf8Bytes } from './layout';

export type Sheet = {
  /** The text drawn, trimmed of edge whitespace. */
  text: string;
  /** Source offsets, `[start, end)`. Whitespace between sheets belongs to neither. */
  start: number;
  end: number;
};

/**
 * Byte budget per sheet. The first can be smaller so a heading drawn above it
 * still leaves the whole sheet under the container limit.
 */
export type SheetBudget = { first: number; rest: number };

/** Index just past the longest run of `text` from `from` that fits in `budget` bytes. */
function fitEnd(text: string, from: number, budget: number): number {
  let bytes = 0;
  let i = from;
  while (i < text.length) {
    const cp = text.codePointAt(i) as number;
    // A lone surrogate encodes as U+FFFD, three bytes — the same as its range here.
    const size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + size > budget) break;
    bytes += size;
    i += cp > 0xffff ? 2 : 1;
  }
  return i;
}

/** Just past the last sentence end in `s` (terminal punctuation, closers, then space), or 0. */
function lastSentenceEnd(s: string): number {
  let end = 0;
  for (const m of s.matchAll(/[.!?…]["'”’)\]]*\s/g)) end = (m.index ?? 0) + m[0].length;
  return end;
}

/**
 * Where to end the sheet starting at `from`.
 *
 * A paragraph break is the cleanest page turn, but taking an early one wastes
 * the rest of the sheet and costs the reader an extra turn — so it wins only
 * when it keeps most of the sheet. Otherwise the sheet runs on to the last
 * whole sentence, and only then to the last whole word.
 */
function cutAt(text: string, from: number, budget: number): number {
  const limit = fitEnd(text, from, budget);
  if (limit >= text.length) return text.length;

  const window = text.slice(from, limit);
  const fill = (cut: number) => utf8Bytes(text.slice(from, cut)) / budget;
  const para = from + window.lastIndexOf('\n') + 1;
  const sentence = from + lastSentenceEnd(window);
  const word = from + window.lastIndexOf(' ') + 1;

  if (para > from && fill(para) >= 0.75) return para;
  if (sentence > from && fill(sentence) >= 0.5) return sentence;
  if (para > from && fill(para) >= 0.5) return para;
  if (word > from) return word;
  // Nothing to break on — a long URL, a run of unspaced script. Cut where the
  // bytes run out, and always advance so a pathological input cannot loop.
  return Math.max(limit, from + 1);
}

/** Split `text` into sheets. Never returns an empty list. */
export function toSheets(text: string, budget: SheetBudget): Sheet[] {
  const out: Sheet[] = [];
  let pos = 0;
  while (pos < text.length) {
    // A sheet never opens on a blank line: the gap between paragraphs is
    // already implied by the page turn.
    while (pos < text.length && /\s/.test(text[pos])) pos++;
    if (pos >= text.length) break;
    const end = cutAt(text, pos, out.length === 0 ? budget.first : budget.rest);
    out.push({ text: text.slice(pos, end).trim(), start: pos, end });
    pos = end;
  }
  return out.length > 0 ? out : [{ text: '', start: 0, end: 0 }];
}

/** The sheet holding source offset `offset` — the last one starting at or before it. */
export function sheetAt(sheets: readonly Sheet[], offset: number): number {
  let found = 0;
  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].start <= offset) found = i;
    else break;
  }
  return found;
}
