/**
 * Layout primitive tests.
 *
 * These guard the geometry rules the firmware will not enforce for us: it does
 * not clip text to its container, so anything that overflows prints over
 * whatever is below it — and it draws border and padding INSIDE the box, so a
 * text area that is not a whole number of 27px lines gets a scrollbar.
 */

import { describe, it, expect } from 'vitest';
import * as L from './layout';

describe('boxHeight — border and padding are inside the box', () => {
  it('adds padding and border on both sides of n firmware lines', () => {
    expect(L.boxHeight(1, 4)).toBe(35);
    expect(L.boxHeight(2, 3, 1)).toBe(62);
    expect(L.lines(1)).toBe(L.boxHeight(1, 4, 0));
  });

  // The bug this exists for: a 2-line card at 54 + 2×3 with a 1px border left
  // 52px for 54px of text, and the firmware drew a scrollbar on every card.
  it('sizes a card to hold exactly two lines inside its border', () => {
    const c = L.card('row0', 'a\nb', 0, true);
    expect(c.height - 2 * (c.paddingLength + c.borderWidth)).toBe(2 * L.LINE);
  });

  it('sizes a tile to hold exactly one line, focused or not', () => {
    for (const focused of [true, false]) {
      const t = L.tile('view0', 'x', 44, 1, focused);
      expect(t.height - 2 * (t.paddingLength + t.borderWidth)).toBe(L.LINE);
    }
  });

  it('keeps three cards clear of the footer', () => {
    const last = L.card('row2', 'x', 2, false);
    expect(last.yPosition + last.height).toBeLessThanOrEqual(L.ROW.footer);
  });
});

describe('screen — the firmware rules, as a throw', () => {
  const valid = () => [L.header('h'), L.footer('f'), L.captureLayer()];

  it('accepts the furniture', () => {
    L.beginScreen();
    expect(() => L.screen('ok', valid())).not.toThrow();
  });

  it('rejects a text area that is not a whole number of lines', () => {
    L.beginScreen();
    const bad = { ...L.header('h'), height: 40 };
    expect(() => L.screen('bad', [bad, L.captureLayer()])).toThrow(/scrollbar/);
  });

  it('rejects a bordered box whose border eats the last line', () => {
    L.beginScreen();
    const bad = { ...L.header('h'), borderWidth: 1 };
    expect(() => L.screen('bad', [bad, L.captureLayer()])).toThrow(/scrollbar/);
  });

  it('lets a blank capture layer be any height', () => {
    L.beginScreen();
    expect(() => L.screen('ok', [L.captureLayer()])).not.toThrow();
  });

  it('rejects a box that leaves the canvas', () => {
    L.beginScreen();
    const bad = { ...L.footer('f'), yPosition: 260 };
    expect(() => L.screen('bad', [bad, L.captureLayer()])).toThrow(/canvas/);
  });

  it('insists on exactly one capture container', () => {
    L.beginScreen();
    expect(() => L.screen('none', [L.header('h')])).toThrow(/isEventCapture/);
  });
});

describe('fitPx — measured in the firmware font, not counted', () => {
  it('returns a string that fits unchanged', () => {
    expect(L.fitPx('short', 200)).toBe('short');
  });

  it('cuts on a word boundary and ends in an ellipsis, inside the width', () => {
    const s = L.fitPx('The grid cannot carry the data centres we keep approving', 300);
    expect(s.endsWith('…')).toBe(true);
    expect(s).not.toMatch(/\s…$/);
    expect(L.textWidth(s)).toBeLessThanOrEqual(300);
    expect('The grid cannot carry the data centres we keep approving'.startsWith(s.slice(0, -1))).toBe(true);
  });

  // Capitals are wide, i's are narrow: a character cap cannot know that.
  it('fits more narrow glyphs than wide ones into the same width', () => {
    const wide = L.fitPx('W'.repeat(80), 400).length;
    const narrow = L.fitPx('i'.repeat(80), 400).length;
    expect(narrow).toBeGreaterThan(wide);
  });
});

describe('fitBytes — pixels do not bound size', () => {
  it('returns a string under budget unchanged', () => {
    expect(L.fitBytes('short', 100)).toBe('short');
  });

  // 500 curly quotes are narrow on screen and 1,500 bytes long.
  it('cuts to the byte budget, ellipsis included', () => {
    const s = L.fitBytes('’'.repeat(500), 240);
    expect(L.utf8Bytes(s)).toBeLessThanOrEqual(240);
    expect(s.endsWith('…')).toBe(true);
  });

  it('prefers a word boundary', () => {
    const s = L.fitBytes('alpha bravo charlie delta echo foxtrot', 24);
    expect(s).toBe('alpha bravo charlie…');
    expect(L.utf8Bytes(s)).toBeLessThanOrEqual(24);
  });
});

describe('wrapLines — measure the real wrap, not a character guess', () => {
  const W = L.innerWidth(560, 4);

  it('wraps on word boundaries, never mid-word, inside the width', () => {
    for (const line of L.wrapLines('alpha bravo charlie delta echo '.repeat(20), W)) {
      expect(line).not.toMatch(/\s$/);
      expect(L.textWidth(line)).toBeLessThanOrEqual(W);
    }
  });

  /**
   * The bug this exists for: a blank line between paragraphs costs a whole row,
   * so a character cap under-counts badly. 351 characters wrapped to ELEVEN
   * lines in a 7-line box and printed over the meta row below.
   */
  it('counts blank lines between paragraphs as real lines', () => {
    expect(L.wrapLines('a\n\nb\n\nc', W)).toEqual(['a', '', 'b', '', 'c']);
  });

  it('a narrower container yields more lines for the same text', () => {
    const src = 'word '.repeat(60);
    expect(L.wrapLines(src, 264).length).toBeGreaterThan(L.wrapLines(src, 560).length);
  });
});

describe('bar — a progress bar the font can draw', () => {
  it('fills left to right with the documented glyphs', () => {
    expect(L.bar(0)).toBe('────────');
    expect(L.bar(0.5)).toBe('━━━━────');
    expect(L.bar(1)).toBe('━━━━━━━━');
  });

  it('clamps outside 0..1', () => {
    expect(L.bar(-1)).toBe(L.bar(0));
    expect(L.bar(7)).toBe(L.bar(1));
  });
});

describe('hint — one grammar for every footer', () => {
  it('joins gesture-verb pairs with middle dots and never teaches a plain hold as the menu', () => {
    const h = L.hint(L.HINT.swipe, L.HINT.open, L.HINT.menu, L.HINT.back);
    expect(h).toBe('Swipe · Press open · Tap-hold menu · Double back');
    expect(h).not.toMatch(/(^|[^-])Hold menu/);
    expect(h).not.toContain(':');
  });
});
