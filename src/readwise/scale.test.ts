/**
 * The selectors at the REAL library size.
 *
 * The card measured the live library on 2026-08-06: 477 in `new`, 1,014 in
 * `later`. The whole argument for this app is that those numbers are
 * unbrowsable, so the views must stay SHORT and cheap no matter how big the
 * library gets. A view that degrades at scale defeats its own purpose — and a
 * fixture of three documents would never show it.
 */

import { describe, it, expect } from 'vitest';
import { today, halfRead, surprise, MAX_ROWS } from './views';
import type { Doc } from './client';

const NOW = new Date('2026-08-06T18:00:00Z');

/** A library shaped like the measured one. */
function library(): Doc[] {
  const out: Doc[] = [];
  const mk = (i: number, over: Partial<Doc>): Doc => ({
    id: `d${i}`, title: `Article ${i}`, author: 'A', site_name: 'S',
    url: 'u', category: 'article', location: 'later', reading_progress: 0,
    reading_time: '10 mins', saved_at: '2026-01-01T10:00:00Z', summary: null, ...over,
  });
  // 477 in `new`, a handful saved today.
  for (let i = 0; i < 477; i++) {
    out.push(mk(i, {
      location: 'new',
      saved_at: i < 6 ? '2026-08-06T09:00:00Z' : '2026-05-01T10:00:00Z',
    }));
  }
  // 1,014 in `later`. The card's live sample found 2 half-read in 20, so ~10%.
  for (let i = 0; i < 1014; i++) {
    out.push(mk(1000 + i, {
      location: 'later',
      reading_progress: i % 10 === 0 ? 0.5 : 0,
    }));
  }
  return out;
}

describe('at the measured library size', () => {
  const docs = library();

  it('the library really is as big as the card says', () => {
    expect(docs).toHaveLength(477 + 1014);
  });

  // The point of Today is that it is what you captured while it is still warm —
  // it must not become a month of backlog.
  it('Today stays small', () => {
    expect(today(docs, NOW)).toHaveLength(6);
  });

  // "The pile that guilt is made of." ~100 half-read items exist, but the view
  // is capped so the list container is never overrun.
  it('Half-read is capped rather than showing a hundred items', () => {
    expect(halfRead(docs)).toHaveLength(MAX_ROWS);
  });

  // THE view that exists to defeat 1,014 items of paralysis.
  it('Surprise me returns a handful drawn from the whole later queue', () => {
    const picked = surprise(docs, () => 0.5);
    expect(picked).toHaveLength(MAX_ROWS);
    expect(picked.every((d) => d.location === 'later')).toBe(true);
    expect(picked.every((d) => d.reading_progress === 0)).toBe(true);
  });

  it('Surprise me draws from across the queue, not just the head', () => {
    // A biased or truncating shuffle would return the same slice every time.
    let seed = 1;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const a = new Set(surprise(docs, rand).map((d) => d.id));
    const b = new Set(surprise(docs, rand).map((d) => d.id));
    const overlap = [...a].filter((id) => b.has(id)).length;
    // Two independent draws from ~900 candidates should barely overlap.
    expect(overlap).toBeLessThan(MAX_ROWS / 2);
  });

  // Every view runs on each render of a list screen, on a phone-tethered
  // device. Cheap enough that no caching layer is needed for the selectors.
  it('every view is fast enough to run per render', () => {
    const start = performance.now();
    for (let i = 0; i < 50; i++) {
      today(docs, NOW);
      halfRead(docs);
      surprise(docs, () => 0.5);
    }
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
