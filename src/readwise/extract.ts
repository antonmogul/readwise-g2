/**
 * HTML → plaintext, for the paginated glasses reader.
 *
 * Readwise returns real publisher HTML: one sampled Guardian article was
 * 30,734 chars of markup that reduced to 18,443 chars of text. So this is not
 * a toy tag-stripper — it has to drop script/style content entirely, keep
 * paragraph boundaries (they are the only structure a 4-bit display can show),
 * and decode entities, or the reader fills with `&nbsp;` and `&#8217;`.
 *
 * Deliberately regex-based rather than DOM-based: this runs inside the Even Hub
 * webview on the phone AND is unit-tested in node. Depending on DOMParser would
 * mean two code paths and a class of bug that only appears on hardware.
 */

/** Block-level tags whose boundaries become paragraph breaks. */
const BLOCK = 'p|div|section|article|header|footer|li|ul|ol|blockquote|figure|figcaption|h[1-6]|br|tr|pre';

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

/** Named and numeric entities. Unknown names are left alone, not blanked. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) =>
      String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (whole, name) =>
      ENTITIES[name.toLowerCase()] ?? whole);
}

/**
 * Strip HTML to readable text.
 *
 * Order matters: script/style are removed WITH their contents first. Stripping
 * tags first would leave the JavaScript source sitting in the article body,
 * which is exactly the failure a naive `replace(/<[^>]+>/g, '')` produces.
 */
export function htmlToText(html: string): string {
  if (!html) return '';

  let s = html;

  // Comments, and elements whose text content is never prose.
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|noscript|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');

  // Block boundaries become newlines BEFORE tags are stripped, otherwise every
  // paragraph runs into the next and the reader is one undifferentiated wall.
  s = s.replace(new RegExp(`<\\s*/?\\s*(${BLOCK})\\b[^>]*>`, 'gi'), '\n');

  // Everything else is inline; drop the tag, keep the text.
  s = s.replace(/<[^>]+>/g, '');

  s = decodeEntities(s);

  // Normalise whitespace. Non-breaking spaces survive decoding as U+00A0 and
  // would otherwise defeat the word-wrap in layout.ts, which splits on ' '.
  s = s.replace(/ /g, ' ');
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  // Collapse runs of blank lines to a single blank: on a 288px canvas, three
  // blank lines is an eighth of the screen spent on nothing.
  s = s.replace(/\n{3,}/g, '\n\n');

  return s.trim();
}

/**
 * Drop an opening paragraph that is the article's own title.
 *
 * Publisher `html_content` commonly opens with the title as an `<h1>`, and the
 * reader already heads its first sheet with `doc.title` — so the first sheet
 * read the title twice (simulator, 2026-10-29, against the stand-in's
 * "Ignored heading" fixture). Compared loosely: case, surrounding whitespace
 * and trailing punctuation differ between a publisher's h1 and Reader's title.
 */
export function dropLeadingTitle(title: string, text: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();
  const nl = text.indexOf('\n');
  const first = nl < 0 ? text : text.slice(0, nl);
  if (!first.trim() || norm(first) !== norm(title)) return text;
  return nl < 0 ? '' : text.slice(nl).replace(/^\s+/, '');
}

/** Rough word count, for reading-time and pagination sanity checks. */
export const wordCount = (text: string): number =>
  text.split(/\s+/).filter(Boolean).length;

/**
 * First N characters of readable text, on a sentence boundary where possible.
 * Used as the fallback "gist" when the Brain is unreachable — better than a
 * blank summary screen, and honestly labelled as an extract, not a summary.
 */
export function excerpt(text: string, max = 400): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (stop > max * 0.5) return cut.slice(0, stop + 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}
