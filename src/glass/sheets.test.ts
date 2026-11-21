import { describe, it, expect } from 'vitest';
import { toSheets, sheetAt } from './sheets';
import { utf8Bytes, SHEET_BYTES, MAX_CONTENT_BYTES } from './layout';

const BUDGET = { first: 900, rest: 900 };

/** Paragraphs of real-shaped prose: curly quotes, em dashes, varied length. */
function article(paragraphs = 30): string {
  const sentence = (p: number, s: number) =>
    `Sentence ${s} of paragraph ${p} carries a “quoted” clause — and a dash.`;
  return Array.from({ length: paragraphs }, (_, p) =>
    Array.from({ length: 2 + (p % 5) }, (_, s) => sentence(p, s)).join(' ')).join('\n\n');
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('toSheets', () => {
  it('keeps every sheet inside its byte budget', () => {
    const sheets = toSheets(article(), BUDGET);
    expect(sheets.length).toBeGreaterThan(3);
    for (const s of sheets) expect(utf8Bytes(s.text)).toBeLessThanOrEqual(900);
  });

  it('counts bytes, not characters — curly quotes are three bytes each', () => {
    const quotes = '“'.repeat(400); // 400 characters, 1,200 bytes
    const sheets = toSheets(quotes, { first: 300, rest: 300 });
    for (const s of sheets) expect(utf8Bytes(s.text)).toBeLessThanOrEqual(300);
    expect(sheets.map((s) => s.text).join('')).toBe(quotes);
  });

  it('loses and duplicates nothing across sheets', () => {
    const text = article();
    const sheets = toSheets(text, BUDGET);
    expect(squash(sheets.map((s) => s.text).join(' '))).toBe(squash(text));
  });

  it('keeps offsets ordered and non-overlapping, and maps them back to the text', () => {
    const text = article();
    const sheets = toSheets(text, BUDGET);
    for (let i = 0; i < sheets.length; i++) {
      expect(text.slice(sheets[i].start, sheets[i].end).trim()).toBe(sheets[i].text);
      if (i > 0) expect(sheets[i].start).toBeGreaterThanOrEqual(sheets[i - 1].end);
    }
    expect(sheets.at(-1)!.end).toBe(text.length);
  });

  it('turns the page at a paragraph break when that keeps most of the sheet', () => {
    const para = 'Word '.repeat(150).trim(); // 749 bytes
    const sheets = toSheets(`${para}\n\n${para}`, BUDGET);
    expect(sheets).toHaveLength(2);
    expect(sheets[0].text).toBe(para);
    expect(sheets[1].text).toBe(para);
  });

  it('runs on to a sentence end rather than wasting half a sheet on an early break', () => {
    const short = 'A short opening line.';
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} ends here.`).join(' ');
    const sheets = toSheets(`${short}\n\n${long}`, BUDGET);
    expect(sheets[0].text.startsWith(short)).toBe(true);
    expect(utf8Bytes(sheets[0].text)).toBeGreaterThan(450);
    expect(sheets[0].text).toMatch(/here\.$/);
    expect(sheets[1].text).toMatch(/^Sentence number \d+ ends here\./);
  });

  it('never cuts a word when there is a space to cut at', () => {
    const text = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    const sheets = toSheets(text, BUDGET);
    const words = new Set(text.split(' '));
    for (const s of sheets) {
      for (const w of s.text.split(' ')) expect(words.has(w)).toBe(true);
    }
  });

  it('still makes progress through text with nowhere to break', () => {
    const url = `https://example.com/${'x'.repeat(2500)}`;
    const sheets = toSheets(url, BUDGET);
    expect(sheets.map((s) => s.text).join('')).toBe(url);
    for (const s of sheets) expect(utf8Bytes(s.text)).toBeLessThanOrEqual(900);
  });

  it('gives the first sheet its own, smaller budget', () => {
    const sheets = toSheets(article(), { first: 400, rest: 900 });
    expect(utf8Bytes(sheets[0].text)).toBeLessThanOrEqual(400);
    expect(utf8Bytes(sheets[1].text)).toBeGreaterThan(400);
  });

  it('never opens a sheet on a blank line', () => {
    for (const s of toSheets(article(), BUDGET)) expect(s.text).toBe(s.text.trim());
  });

  it('returns one empty sheet for empty or blank text', () => {
    expect(toSheets('', BUDGET)).toEqual([{ text: '', start: 0, end: 0 }]);
    expect(toSheets('\n\n  \n', BUDGET)).toEqual([{ text: '', start: 0, end: 0 }]);
  });

  it('leaves the real budget under the container limit', () => {
    expect(SHEET_BYTES).toBeLessThan(MAX_CONTENT_BYTES);
  });
});

describe('sheetAt', () => {
  const text = article();
  const sheets = toSheets(text, BUDGET);

  it('finds the sheet holding an offset', () => {
    for (let i = 0; i < sheets.length; i++) {
      expect(sheetAt(sheets, sheets[i].start)).toBe(i);
      expect(sheetAt(sheets, sheets[i].end - 1)).toBe(i);
    }
  });

  it('clamps offsets outside the text', () => {
    expect(sheetAt(sheets, -5)).toBe(0);
    expect(sheetAt(sheets, text.length + 100)).toBe(sheets.length - 1);
  });
});
