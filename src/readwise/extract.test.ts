import { describe, it, expect } from 'vitest';
import { htmlToText, decodeEntities, wordCount, excerpt, dropLeadingTitle } from './extract';

describe('dropLeadingTitle', () => {
  // Publisher html_content opens with the title as an <h1>; the reader heads
  // its first sheet with doc.title already, so the title read twice.
  it('drops an opening paragraph that repeats the title', () => {
    expect(dropLeadingTitle('A short note', 'A short note\n\nFirst paragraph.\n\nSecond.'))
      .toBe('First paragraph.\n\nSecond.');
  });

  it('compares loosely: case, whitespace and punctuation', () => {
    expect(dropLeadingTitle('Why Attention Markets Eat Focus', '  why attention markets eat focus!\nBody.'))
      .toBe('Body.');
  });

  it('leaves a body whose first line is prose alone', () => {
    const text = 'The operator promises to pay.\n\nMore.';
    expect(dropLeadingTitle('A short note', text)).toBe(text);
  });

  it('leaves an empty body empty', () => {
    expect(dropLeadingTitle('T', '')).toBe('');
    expect(dropLeadingTitle('T', 'T')).toBe('');
  });
});

describe('decodeEntities', () => {
  it('decodes named entities', () => {
    expect(decodeEntities('Tom &amp; Jerry &mdash; friends')).toBe('Tom & Jerry — friends');
  });

  it('decodes numeric and hex entities', () => {
    expect(decodeEntities('&#8217;s &#x2014; here')).toBe('’s — here');
  });

  // Blanking an unknown entity would silently eat text; leaving it is honest.
  it('leaves unknown entities alone', () => {
    expect(decodeEntities('&notareal; thing')).toBe('&notareal; thing');
  });
});

describe('htmlToText', () => {
  it('strips tags and keeps prose', () => {
    expect(htmlToText('<p>Hello <em>there</em></p>')).toBe('Hello there');
  });

  // The failure a naive tag-stripper produces: JavaScript source in the body.
  it('removes script and style CONTENT, not just their tags', () => {
    const html = '<p>Real text</p><script>var x = 1; alert("hi")</script><style>.a{color:red}</style>';
    const out = htmlToText(html);
    expect(out).toContain('Real text');
    expect(out).not.toContain('alert');
    expect(out).not.toContain('color:red');
  });

  // A blank line between paragraphs, not a bare newline: the open and close
  // tags each emit a break. That is wanted — on a 4-bit display with one font
  // and no indentation, vertical space is the ONLY paragraph cue available.
  it('separates paragraphs with a blank line', () => {
    expect(htmlToText('<p>One</p><p>Two</p>')).toBe('One\n\nTwo');
  });

  it('keeps paragraphs from running together', () => {
    expect(htmlToText('<div>First</div><div>Second</div>')).not.toContain('FirstSecond');
  });

  it('collapses long runs of blank lines', () => {
    expect(htmlToText('<p>A</p><br><br><br><br><p>B</p>')).toBe('A\n\nB');
  });

  // U+00A0 survives entity decoding and would defeat the space-splitting
  // word wrap in layout.ts, producing lines that overflow their container.
  it('normalises non-breaking spaces to real spaces', () => {
    const out = htmlToText('<p>a&nbsp;b</p>');
    expect(out).toBe('a b');
    expect(out).not.toContain(' ');
  });

  it('drops comments', () => {
    expect(htmlToText('<p>Kept</p><!-- dropped -->')).toBe('Kept');
  });

  it('handles empty input', () => {
    expect(htmlToText('')).toBe('');
  });

  it('reduces realistic markup to a fraction of its size', () => {
    // Mirrors the measured sample: 30,734 chars of HTML → 18,443 of text.
    const para = '<p>Some reasonably long sentence of article prose here.</p>';
    const html = `<div class="a"><script>junk()</script>${para.repeat(200)}</div>`;
    const out = htmlToText(html);
    expect(out.length).toBeLessThan(html.length);
    expect(out).not.toContain('junk');
    // 200 paragraphs, each followed by a blank line separator.
    expect(out.split('\n\n')).toHaveLength(200);
  });
});

describe('wordCount', () => {
  it('counts words across newlines', () => {
    expect(wordCount('one two\nthree  four')).toBe(4);
  });

  it('is zero for empty text', () => {
    expect(wordCount('')).toBe(0);
  });
});

describe('excerpt', () => {
  it('returns short text unchanged', () => {
    expect(excerpt('Short.', 400)).toBe('Short.');
  });

  // Only when the boundary is past halfway: cutting at a full stop that sits
  // in the first few words would throw away most of the allowance and return
  // a "summary" of one sentence when several would have fit.
  it('cuts on a sentence boundary past the halfway mark', () => {
    const text = 'A'.repeat(60) + '. ' + 'x'.repeat(400);
    expect(excerpt(text, 100)).toBe('A'.repeat(60) + '.');
  });

  it('ignores a sentence boundary too early to be useful', () => {
    const text = 'Hi. ' + 'x'.repeat(400);
    expect(excerpt(text, 100)).not.toBe('Hi.');
  });

  it('falls back to a word boundary with an ellipsis', () => {
    const text = 'word '.repeat(100);
    const out = excerpt(text, 50);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(51);
  });

  it('never exceeds the requested length by more than the ellipsis', () => {
    const out = excerpt('a'.repeat(1000), 120);
    expect(out.length).toBeLessThanOrEqual(121);
  });
});
