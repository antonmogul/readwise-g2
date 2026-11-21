/**
 * Feed digest grouping and triage application.
 *
 * The grouping is the fallback the whole feature rests on: when the Brain is
 * unreachable this is the digest, so it must never throw and never depend on a
 * model. `applyTriage` is the other half — it is where MODEL OUTPUT crosses
 * into the render path, and everything it produces is validated against
 * documents actually held.
 */

import { describe, it, expect } from 'vitest';
import {
  groupByPublication, applyTriage, isRecent, isFeedReadable, publicationOf, sectionLabel,
  digestDocs, MAX_SECTIONS, MAX_PER_SECTION, RECENT_HOURS,
} from './digest';
import type { Doc } from './client';

const NOW = new Date('2026-08-09T12:00:00Z');
const hoursAgo = (h: number) =>
  new Date(NOW.getTime() - h * 3_600_000).toISOString();

const doc = (over: Partial<Doc> & { id: string }): Doc => ({
  title: `Title ${over.id}`, author: null, site_name: 'The Verge', url: 'u',
  category: 'article', location: 'feed', reading_progress: 0, reading_time: '5 mins',
  saved_at: hoursAgo(1), summary: null, ...over,
});

describe('publicationOf', () => {
  it('names the publication', () => {
    expect(publicationOf(doc({ id: '1', site_name: 'The Guardian' }))).toBe('The Guardian');
  });

  it('is honest about not knowing rather than inventing a name', () => {
    expect(publicationOf(doc({ id: '1', site_name: null }))).toBe('Unattributed');
    expect(publicationOf(doc({ id: '1', site_name: '  ' }))).toBe('Unattributed');
  });
});

describe('Feed-readable categories', () => {
  it('keeps RSS and newsletters while excluding non-reading media', () => {
    expect(isFeedReadable(doc({ id: 'rss', category: 'rss' }))).toBe(true);
    expect(isFeedReadable(doc({ id: 'email', category: 'email' }))).toBe(true);
    expect(isFeedReadable(doc({ id: 'video', category: 'video' }))).toBe(false);
  });
});

describe('isRecent', () => {
  it('accepts today and the evening before', () => {
    expect(isRecent(hoursAgo(1), NOW)).toBe(true);
    expect(isRecent(hoursAgo(20), NOW)).toBe(true);
  });

  it('rejects anything past the window', () => {
    expect(isRecent(hoursAgo(RECENT_HOURS + 1), NOW)).toBe(false);
  });

  it('keeps future timestamps — clock skew is not a reason to hide an item', () => {
    expect(isRecent(new Date(NOW.getTime() + 60_000).toISOString(), NOW)).toBe(true);
  });

  it('rejects an unparseable date rather than throwing', () => {
    expect(isRecent('not a date', NOW)).toBe(false);
  });
});

describe('groupByPublication', () => {
  it('buckets by publication, biggest section first', () => {
    const docs = [
      doc({ id: '1', site_name: 'A' }),
      doc({ id: '2', site_name: 'B' }),
      doc({ id: '3', site_name: 'B' }),
    ];
    const out = groupByPublication(docs, NOW);
    expect(out[0].name).toBe('B');
    expect(out[0].docs).toHaveLength(2);
    expect(out[1].name).toBe('A');
  });

  it('drops stale items', () => {
    const docs = [doc({ id: '1' }), doc({ id: '2', saved_at: hoursAgo(200) })];
    expect(digestDocs({ sections: groupByPublication(docs, NOW), fromBrain: false, considered: 2 }))
      .toHaveLength(1);
  });

  it('excludes non-articles — they do not read at 576x288', () => {
    const docs = [doc({ id: '1' }), doc({ id: '2', category: 'video' })];
    const out = groupByPublication(docs, NOW);
    expect(digestDocs({ sections: out, fromBrain: false, considered: 2 })).toHaveLength(1);
  });

  it('caps sections and items so a digest stays a digest', () => {
    const docs = Array.from({ length: 40 }, (_, i) =>
      doc({ id: String(i), site_name: `Pub ${i % 12}` }));
    const out = groupByPublication(docs, NOW);
    expect(out.length).toBeLessThanOrEqual(MAX_SECTIONS);
    for (const s of out) expect(s.docs.length).toBeLessThanOrEqual(MAX_PER_SECTION);
  });

  it('orders newest first inside a section', () => {
    const docs = [
      doc({ id: 'old', saved_at: hoursAgo(10) }),
      doc({ id: 'new', saved_at: hoursAgo(1) }),
    ];
    expect(groupByPublication(docs, NOW)[0].docs[0].id).toBe('new');
  });

  it('returns nothing for an empty feed rather than throwing', () => {
    expect(groupByPublication([], NOW)).toEqual([]);
  });
});

describe('applyTriage', () => {
  const docs = [doc({ id: 'a' }), doc({ id: 'b' }), doc({ id: 'c' })];

  it('builds sections from the picks', () => {
    const out = applyTriage(docs, [{ name: 'AI policy', ids: ['a', 'c'], note: 'two takes' }]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('AI policy');
    expect(out[0].docs.map((d) => d.id)).toEqual(['a', 'c']);
    expect(out[0].note).toBe('two takes');
  });

  it('drops hallucinated ids — the model cannot invent an article', () => {
    const out = applyTriage(docs, [{ name: 'S', ids: ['a', 'nope'] }]);
    expect(out[0].docs.map((d) => d.id)).toEqual(['a']);
  });

  it('drops a section whose ids all resolve to nothing', () => {
    // Otherwise the digest shows a row that opens onto an empty list.
    expect(applyTriage(docs, [{ name: 'Ghost', ids: ['x', 'y'] }])).toEqual([]);
  });

  it('names a section even when the model left the name blank', () => {
    expect(applyTriage(docs, [{ name: '  ', ids: ['a'] }])[0].name).toBe('Worth a look');
  });

  it('caps sections and items the same as grouping', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ name: `S${i}`, ids: ['a', 'b', 'c'] }));
    expect(applyTriage(docs, many).length).toBeLessThanOrEqual(MAX_SECTIONS);
    const big = applyTriage(docs, [{ name: 'S', ids: ['a', 'b', 'c', 'a', 'b', 'c'] }]);
    expect(big[0].docs.length).toBeLessThanOrEqual(MAX_PER_SECTION);
  });
});

describe('sectionLabel', () => {
  it('shows the count, and the reason when the Brain gave one', () => {
    expect(sectionLabel({ name: 'AI', docs: [doc({ id: '1' })], note: 'new rules' }))
      .toBe('AI (1) — new rules');
  });

  it('omits the dash when grouping alone', () => {
    expect(sectionLabel({ name: 'The Verge', docs: [doc({ id: '1' })], note: null }))
      .toBe('The Verge (1)');
  });
});
