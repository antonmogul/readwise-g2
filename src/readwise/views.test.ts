import { describe, it, expect } from 'vitest';
import {
  recent, today, halfRead, surprise, select, rowLabel, isSameLocalDay, quick, long, savesByDay,
  reconcileRows, focusOn,
  MAX_ROWS, HALF_READ_MIN, HALF_READ_MAX,
} from './views';

describe('reconcileRows — a refresh landed under the held rows', () => {
  const held = [doc({ id: 'c' }), doc({ id: 'a' }), doc({ id: 'b' })];

  it('keeps the held order and drops documents the library no longer has', () => {
    const fresh = [doc({ id: 'a' }), doc({ id: 'c' }), doc({ id: 'new' })];
    expect(reconcileRows(held, fresh).map((d) => d.id)).toEqual(['c', 'a']);
  });

  // Surprise is a shuffle: re-selecting would move every row under the cursor.
  it('never re-selects — new documents are not inserted', () => {
    expect(reconcileRows(held, [...held, doc({ id: 'new' })]).map((d) => d.id)).toEqual(['c', 'a', 'b']);
  });

  it('swaps each row for its fresh document', () => {
    const fresh = [doc({ id: 'a', reading_progress: 0.5 })];
    expect(reconcileRows(held, fresh)[0].reading_progress).toBe(0.5);
  });

  it('is empty when nothing resolves', () => {
    expect(reconcileRows(held, [])).toEqual([]);
  });
});

describe('focusOn — where focus lands after rows changed', () => {
  const rows = [doc({ id: 'a' }), doc({ id: 'b' }), doc({ id: 'c' })];

  it('stays on the same document when it is still there', () => {
    expect(focusOn(rows, 'c', 0)).toBe(2);
  });

  it('clamps into the list when the focused document is gone', () => {
    expect(focusOn(rows, 'gone', 7)).toBe(2);
    expect(focusOn(rows, null, 1)).toBe(1);
  });

  it('is 0 for an empty list', () => {
    expect(focusOn([], 'a', 3)).toBe(0);
  });
});
import type { Doc } from './client';

const doc = (over: Partial<Doc> & { id: string }): Doc => ({
  title: `Article ${over.id}`,
  author: 'A. Writer',
  site_name: 'The Guardian',
  url: 'https://example.com',
  category: 'article',
  location: 'later',
  reading_progress: 0,
  reading_time: '5 mins',
  saved_at: '2026-08-06T10:00:00Z',
  summary: null,
  ...over,
});

const NOW = new Date('2026-08-06T18:00:00Z');

describe('recent', () => {
  it('is a predictable front door spanning new and later, not just today', () => {
    const docs = [
      doc({ id: 'older', location: 'later', saved_at: '2026-07-01T09:00:00Z' }),
      doc({ id: 'newer', location: 'new', saved_at: '2026-08-05T09:00:00Z' }),
      doc({ id: 'archived', location: 'archive', saved_at: '2026-08-06T09:00:00Z' }),
    ];
    expect(recent(docs).map((d) => d.id)).toEqual(['newer', 'older']);
  });

  it('caps at the HUD list limit', () => {
    const docs = Array.from({ length: 30 }, (_, i) =>
      doc({ id: String(i), saved_at: `2026-08-${String((i % 9) + 1).padStart(2, '0')}T09:00:00Z` }));
    expect(recent(docs)).toHaveLength(MAX_ROWS);
  });
});

describe('isSameLocalDay', () => {
  it('matches the local calendar day', () => {
    expect(isSameLocalDay('2026-08-06T10:00:00Z', NOW)).toBe(true);
  });

  it('rejects a different day', () => {
    expect(isSameLocalDay('2026-08-04T10:00:00Z', NOW)).toBe(false);
  });

  // A malformed date must not throw out of a selector — one bad document
  // would empty the entire list.
  it('treats an unparseable date as no match rather than throwing', () => {
    expect(isSameLocalDay('not-a-date', NOW)).toBe(false);
  });
});

describe('today', () => {
  it('keeps only documents saved today', () => {
    const docs = [
      doc({ id: '1', saved_at: '2026-08-06T09:00:00Z' }),
      doc({ id: '2', saved_at: '2026-08-01T09:00:00Z' }),
    ];
    expect(today(docs, NOW).map((d) => d.id)).toEqual(['1']);
  });

  it('sorts newest first', () => {
    const docs = [
      doc({ id: 'early', saved_at: '2026-08-06T08:00:00Z' }),
      doc({ id: 'late', saved_at: '2026-08-06T16:00:00Z' }),
    ];
    expect(today(docs, NOW).map((d) => d.id)).toEqual(['late', 'early']);
  });

  // The card is explicit: written articles only. A mislabelled video must not
  // reach the glasses even if the API returned it.
  it('drops non-article categories', () => {
    const docs = [
      doc({ id: 'a', saved_at: '2026-08-06T09:00:00Z' }),
      doc({ id: 'v', saved_at: '2026-08-06T09:00:00Z', category: 'video' }),
      doc({ id: 'p', saved_at: '2026-08-06T09:00:00Z', category: 'pdf' }),
    ];
    expect(today(docs, NOW).map((d) => d.id)).toEqual(['a']);
  });

  it('caps at the list container limit', () => {
    const docs = Array.from({ length: 30 }, (_, i) =>
      doc({ id: String(i), saved_at: '2026-08-06T09:00:00Z' }));
    expect(today(docs, NOW)).toHaveLength(MAX_ROWS);
  });
});

describe('halfRead', () => {
  it('excludes both ends of the range', () => {
    const docs = [
      doc({ id: 'untouched', reading_progress: 0 }),
      doc({ id: 'barely', reading_progress: HALF_READ_MIN }),
      doc({ id: 'real', reading_progress: 0.4 }),
      doc({ id: 'nearly', reading_progress: HALF_READ_MAX }),
      doc({ id: 'done', reading_progress: 1 }),
    ];
    expect(halfRead(docs).map((d) => d.id)).toEqual(['real']);
  });

  it('puts the most-progressed first — cheapest to clear', () => {
    const docs = [
      doc({ id: 'a', reading_progress: 0.2 }),
      doc({ id: 'b', reading_progress: 0.8 }),
      doc({ id: 'c', reading_progress: 0.5 }),
    ];
    expect(halfRead(docs).map((d) => d.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('surprise', () => {
  it('only draws unstarted items from later', () => {
    const docs = [
      doc({ id: 'later-new', location: 'later', reading_progress: 0 }),
      doc({ id: 'later-started', location: 'later', reading_progress: 0.5 }),
      doc({ id: 'archived', location: 'archive', reading_progress: 0 }),
      doc({ id: 'feed', location: 'feed', reading_progress: 0 }),
    ];
    expect(surprise(docs, () => 0).map((d) => d.id)).toEqual(['later-new']);
  });

  it('is deterministic under an injected rand', () => {
    const docs = Array.from({ length: 5 }, (_, i) => doc({ id: String(i) }));
    const a = surprise(docs, () => 0.5).map((d) => d.id);
    const b = surprise(docs, () => 0.5).map((d) => d.id);
    expect(a).toEqual(b);
  });

  it('returns every pool item when the pool is small', () => {
    const docs = Array.from({ length: 3 }, (_, i) => doc({ id: String(i) }));
    expect(surprise(docs, () => 0.99).map((d) => d.id).sort()).toEqual(['0', '1', '2']);
  });

  // The whole point of the view is defeating a 1,014-item queue, so it must
  // stay inside the container budget no matter how big the pool is.
  it('caps at the list container limit', () => {
    const docs = Array.from({ length: 500 }, (_, i) => doc({ id: String(i) }));
    expect(surprise(docs, () => 0.5)).toHaveLength(MAX_ROWS);
  });
});

describe('select', () => {
  it('routes each key to its selector', () => {
    const docs = [
      doc({ id: 'today', saved_at: '2026-08-06T09:00:00Z' }),
      doc({ id: 'half', reading_progress: 0.5, saved_at: '2026-01-01T09:00:00Z' }),
    ];
    expect(select('recent', docs, NOW).map((d) => d.id)).toEqual(['today', 'half']);
    expect(select('today', docs, NOW).map((d) => d.id)).toEqual(['today']);
    expect(select('halfread', docs, NOW).map((d) => d.id)).toEqual(['half']);
    expect(select('surprise', docs, NOW, () => 0).map((d) => d.id)).toEqual(['today']);
  });
});

describe('rowLabel', () => {
  it('joins title, publication and reading time', () => {
    expect(rowLabel(doc({ id: '1', title: 'Deep Work' })))
      .toBe('Deep Work  —  The Guardian · 5 min');
  });

  it('omits missing metadata rather than printing blanks', () => {
    expect(rowLabel(doc({ id: '1', title: 'Solo', site_name: null, reading_time: null })))
      .toBe('Solo');
  });
});

describe('quick and long', () => {
  const lengths = [
    doc({ id: 'q', reading_time: '4 mins' }),
    doc({ id: 'edge', reading_time: '5 mins' }),
    doc({ id: 'mid', reading_time: '12 mins' }),
    doc({ id: 'l', reading_time: '20 mins' }),
    doc({ id: 'unknown', reading_time: null }),
    doc({ id: 'started', reading_time: '3 mins', reading_progress: 0.4 }),
    doc({ id: 'archived', reading_time: '3 mins', location: 'archive' }),
    doc({ id: 'pdf', reading_time: '3 mins', category: 'pdf' }),
  ];

  it('quick holds unstarted articles of five minutes or less', () => {
    expect(quick(lengths).map((d) => d.id)).toEqual(['q', 'edge']);
  });

  it('long holds unstarted articles of twenty minutes or more', () => {
    expect(long(lengths).map((d) => d.id)).toEqual(['l']);
  });

  // A missing length is not a short one — guessing would file a book as quick.
  it('leaves unknown lengths out of both', () => {
    expect([...quick(lengths), ...long(lengths)].map((d) => d.id)).not.toContain('unknown');
  });

  it('is reachable through select', () => {
    expect(select('quick', lengths, NOW)).toEqual(quick(lengths));
    expect(select('long', lengths, NOW)).toEqual(long(lengths));
  });
});

describe('savesByDay', () => {
  const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).toISOString();
  const now = new Date(2026, 9, 29, 9);

  it('counts articles per local day, oldest first and today last', () => {
    const docs = [
      doc({ id: 'a', saved_at: at(2026, 10, 29, 1) }),
      doc({ id: 'b', saved_at: at(2026, 10, 29, 8) }),
      doc({ id: 'c', saved_at: at(2026, 10, 28) }),
      doc({ id: 'd', saved_at: at(2026, 10, 23) }),
      doc({ id: 'too-old', saved_at: at(2026, 10, 22) }),
      doc({ id: 'pdf', saved_at: at(2026, 10, 29), category: 'pdf' }),
      doc({ id: 'bad', saved_at: 'not a date' }),
    ];
    expect(savesByDay(docs, now)).toEqual([1, 0, 0, 0, 0, 1, 2]);
  });

  // Rounded day arithmetic: a 23- or 25-hour day must not shift the week.
  it('survives a daylight-saving change inside the week', () => {
    const docs = [doc({ id: 'x', saved_at: at(2026, 3, 27) })];
    expect(savesByDay(docs, new Date(2026, 2, 31, 9))).toEqual([0, 0, 1, 0, 0, 0, 0]);
  });
});
