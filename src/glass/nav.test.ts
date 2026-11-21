import { describe, it, expect } from 'vitest';
import { step, nextAfter, repointFocus, HOME_VIEWS, type Route, type NavContext } from './nav';
import type { Doc } from '../readwise/client';

const doc = (id: string): Doc => ({
  id, title: `T${id}`, author: null, site_name: null, url: 'u',
  category: 'article', location: 'later', reading_progress: 0,
  reading_time: null, saved_at: '2026-08-06T10:00:00Z', summary: null,
});

const ctx = (
  rows: Doc[] = [], pages = 1, summaryPages = 1,
  sections: Array<{ docs: Doc[] }> = [],
  digestError = false,
  digestLoaded = sections.length > 0 || digestError,
): NavContext => ({
  rows, pages, summaryPages, sections, digestLoaded, digestError,
  resumePage: 0, digestStale: false, answerPages: 1, answerDocs: [],
});
const THREE = ctx([doc('a'), doc('b'), doc('c')]);
/** The same context with a few fields changed. */
const withCtx = (over: Partial<NavContext>): NavContext => ({ ...ctx(), ...over });

describe('home', () => {
  const at = (item: (typeof HOME_VIEWS)[number]): Route =>
    ({ name: 'home', focus: HOME_VIEWS.indexOf(item) });

  it('moves focus down the sections with swipes', () => {
    expect(step({ name: 'home', focus: 0 }, ctx(), 'down').route).toEqual({ name: 'home', focus: 1 });
    expect(step({ name: 'home', focus: 3 }, ctx(), 'up').route).toEqual({ name: 'home', focus: 2 });
  });

  // Wrapping from the first section would skip the dashboard above it.
  it('clamps at both ends instead of wrapping, and draws nothing there', () => {
    const top: Route = { name: 'home', focus: 0 };
    const bottom: Route = { name: 'home', focus: HOME_VIEWS.length - 1 };
    expect(step(top, ctx(), 'up')).toEqual({ route: top, effect: { kind: 'none' } });
    expect(step(bottom, ctx(), 'down')).toEqual({ route: bottom, effect: { kind: 'none' } });
  });

  it('opens the focused library section on press', () => {
    for (const view of ['recent', 'quick', 'halfread', 'long', 'surprise'] as const) {
      expect(step(at(view), ctx(), 'press'))
        .toEqual({ route: { name: 'list', view, focus: 0 }, effect: { kind: 'none' } });
    }
  });

  it('opens the Feed from its row, loading it only then', () => {
    expect(step(at('digest'), ctx(), 'press'))
      .toEqual({ route: { name: 'digest', focus: 0 }, effect: { kind: 'loadDigest' } });
  });

  it('asks the library from its row, and returns to that row', () => {
    const home = at('ask');
    expect(step(home, ctx(), 'press')).toEqual({
      route: { name: 'ask', phase: 'listening', page: 0, from: home },
      effect: { kind: 'listen' },
    });
  });

  it('lands back on the row a section was opened from', () => {
    expect(step({ name: 'list', view: 'long', focus: 2 }, ctx(), 'double').route).toEqual(at('long'));
  });

  it('opens library sections from contextual-menu gestures', () => {
    expect(step({ name: 'home', focus: 0 }, ctx(), 'navContinue').route)
      .toEqual({ name: 'list', view: 'halfread', focus: 0 });
    const s = step({ name: 'digest', focus: 2 }, ctx(), 'navRecent');
    expect(s.route).toEqual({ name: 'list', view: 'recent', focus: 0 });
    expect(s.effect).toEqual({ kind: 'none' });
  });

  it('fetches Feed only when its contextual-menu item is selected', () => {
    const s = step({ name: 'home', focus: 0 }, ctx(), 'navFeed');
    expect(s.route).toEqual({ name: 'digest', focus: 0 });
    expect(s.effect).toEqual({ kind: 'loadDigest' });
  });

  it('reuses a digest already loaded this session', () => {
    const s = step({ name: 'list', view: 'recent', focus: 0 }, ctx([], 1, 1, [], false, true), 'navFeed');
    expect(s).toEqual({ route: { name: 'digest', focus: 0 }, effect: { kind: 'none' } });
  });

  // QA rejects apps that exit silently — this must reach the system dialog.
  it('exits on double press at the root', () => {
    expect(step({ name: 'home', focus: 0 }, ctx(), 'double').effect)
      .toEqual({ kind: 'exit' });
  });
});

describe('list', () => {
  const list: Route = { name: 'list', view: 'today', focus: 0 };

  it('moves focus through the rows', () => {
    expect(step(list, THREE, 'down').route).toMatchObject({ focus: 1 });
    expect(step({ ...list, focus: 2 }, THREE, 'up').route).toMatchObject({ focus: 1 });
  });

  // Wrapping took a swipe past 20/20 silently to 1/20 — on a display with no
  // scrollbar that read as the list jumping. Clamp, like Home and the sheets,
  // and draw nothing at the ends.
  it('clamps at both ends instead of wrapping, and draws nothing there', () => {
    expect(step(list, THREE, 'up')).toEqual({ route: list, effect: { kind: 'none' } });
    const last = { ...list, focus: 2 };
    expect(step(last, THREE, 'down')).toEqual({ route: last, effect: { kind: 'none' } });
  });

  it('opens the focused article as a summary, not the reader', () => {
    const s = step({ ...list, focus: 1 }, THREE, 'press');
    expect(s.route).toEqual({ name: 'summary', view: 'today', id: 'b', back: 1, page: 0 });
    expect(s.effect).toEqual({ kind: 'openSummary', id: 'b' });
  });

  // Without the guard, rows[0] is undefined and `id: undefined` reaches fetch.
  // Press on an empty list is the way on instead: the dependable front door.
  it('opens Recent from an empty list on press, fetching nothing', () => {
    const s = step(list, ctx([]), 'press');
    expect(s.route).toEqual({ name: 'list', view: 'recent', focus: 0 });
    expect(s.effect).toEqual({ kind: 'none' });
  });

  it('goes home from an empty Recent on press', () => {
    expect(step({ ...list, view: 'recent' }, ctx([]), 'press').route)
      .toEqual({ name: 'home', focus: HOME_VIEWS.indexOf('recent') });
  });

  it('ignores swipes and holds on an empty list', () => {
    for (const g of ['up', 'down', 'hold'] as const) {
      expect(step(list, ctx([]), g)).toEqual({ route: list, effect: { kind: 'none' } });
    }
  });

  it('clamps a stale focus past the end of a shrunken list', () => {
    const s = step({ ...list, focus: 9 }, THREE, 'press');
    expect(s.effect).toEqual({ kind: 'openSummary', id: 'c' });
  });

  it('goes back to home on double press', () => {
    // Derived, not a literal: home gained the digest at position 0 and every
    // hard-coded index shifted underneath these tests.
    expect(step({ ...list, view: 'surprise' }, THREE, 'double').route)
      .toEqual({ name: 'home', focus: HOME_VIEWS.indexOf('surprise') });
  });
});

describe('digest', () => {
  const sections = [{ docs: [doc('a'), doc('b')] }, { docs: [doc('c')] }];
  const digest: Route = { name: 'digest', focus: 0 };
  const dctx = ctx([], 1, 1, sections);

  it('moves between sections, clamped at the ends', () => {
    expect(step(digest, dctx, 'down').route).toMatchObject({ focus: 1 });
    expect(step(digest, dctx, 'up')).toEqual({ route: digest, effect: { kind: 'none' } });
    expect(step({ name: 'digest', focus: 1 }, dctx, 'down').route).toMatchObject({ focus: 1 });
  });

  it('enters the focused section', () => {
    expect(step({ name: 'digest', focus: 1 }, dctx, 'press').route)
      .toEqual({ name: 'section', section: 1, focus: 0 });
  });

  it('does not enter an empty digest', () => {
    // Without the guard the section route indexes into nothing.
    expect(step(digest, ctx(), 'press').route).toEqual(digest);
  });

  it('retries a failed digest only on an explicit press', () => {
    const failed = ctx([], 1, 1, [], true);
    expect(step(digest, failed, 'press').effect)
      .toEqual({ kind: 'loadDigest', retry: true });
    expect(step(digest, failed, 'down').effect).toEqual({ kind: 'none' });
  });

  it('goes home on double press', () => {
    expect(step(digest, dctx, 'double').route)
      .toEqual({ name: 'home', focus: HOME_VIEWS.indexOf('digest') });
  });

  it('does not refetch when moving around — a model turn per swipe', () => {
    expect(step(digest, dctx, 'down').effect).toEqual({ kind: 'none' });
    expect(step(digest, dctx, 'press').effect).toEqual({ kind: 'none' });
  });
});

describe('section', () => {
  const sections = [{ docs: [doc('a'), doc('b')] }, { docs: [doc('c')] }];
  const section: Route = { name: 'section', section: 0, focus: 0 };
  const dctx = ctx([], 1, 1, sections);

  it('opens an article as a summary, remembering it came from the digest', () => {
    const s = step({ ...section, focus: 1 }, dctx, 'press');
    expect(s.route).toMatchObject({
      name: 'summary', id: 'b', origin: { kind: 'section', section: 0 },
    });
    expect(s.effect).toEqual({ kind: 'openSummary', id: 'b' });
  });

  it('returns to the digest with the section still focused', () => {
    expect(step({ name: 'section', section: 1, focus: 0 }, dctx, 'double').route)
      .toEqual({ name: 'digest', focus: 1 });
  });

  it('survives a section index that no longer exists', () => {
    // The digest can be pruned by an archive while a section is open.
    expect(step({ name: 'section', section: 9, focus: 0 }, dctx, 'press').route)
      .toMatchObject({ name: 'section' });
  });
});

describe('leaving an article returns to where it was opened from', () => {
  const fromDigest = {
    name: 'summary' as const, view: 'today' as const, id: 'a',
    back: 2, page: 0, origin: { kind: 'section' as const, section: 1 },
  };

  it('archives back into the section, not into a library list', () => {
    // Hard-coding the list here sent the digest out by the wrong door.
    expect(step(fromDigest, ctx(), 'double').route)
      .toEqual({ name: 'section', section: 1, focus: 2 });
  });

  it('carries the origin through the reader', () => {
    const reader = step(fromDigest, ctx(), 'press').route;
    expect(reader).toMatchObject({ origin: { kind: 'section', section: 1 } });
    expect(step(reader, ctx(), 'double').route)
      .toEqual({ name: 'section', section: 1, focus: 2 });
  });

  it('marks a Feed-origin archive for one explicit Feed refresh', () => {
    expect(step(fromDigest, ctx(), 'archive').effect)
      .toEqual({ kind: 'archive', id: 'a', refreshFeed: true });
  });

  it('still returns to a list when there is no origin', () => {
    const fromList = { ...fromDigest, origin: undefined };
    expect(step(fromList, ctx(), 'double').route)
      .toEqual({ name: 'list', view: 'today', focus: 2 });
  });
});

describe('summary', () => {
  const summary: Route = { name: 'summary', view: 'today', id: 'a', back: 2, page: 0 };

  // The summary scrolls. It used to be clipped to five lines with an ellipsis,
  // which meant deciding whether to read an article from a truncated argument.
  it('pages down through a long summary', () => {
    expect(step(summary, ctx([], 1, 3), 'down').route).toEqual({ ...summary, page: 1 });
  });

  it('pages back up', () => {
    expect(step({ ...summary, page: 2 }, ctx([], 1, 3), 'up').route)
      .toEqual({ ...summary, page: 1 });
  });

  it('clamps at the last page rather than wrapping to the top', () => {
    const last = { ...summary, page: 2 };
    expect(step(last, ctx([], 1, 3), 'down')).toEqual({ route: last, effect: { kind: 'none' } });
  });

  it('clamps at the first page', () => {
    expect(step(summary, ctx([], 1, 3), 'up')).toEqual({ route: summary, effect: { kind: 'none' } });
  });

  it('ignores swipes when the summary fits one screen', () => {
    expect(step(summary, ctx([], 1, 1), 'down')).toEqual({ route: summary, effect: { kind: 'none' } });
  });

  it('does not fetch again when paging — the summary is already loaded', () => {
    // Paging must be a pure route change. An effect here would re-issue the
    // Brain request on every swipe, which is a full Claude turn each time.
    expect(step(summary, ctx([], 1, 3), 'down').effect).toEqual({ kind: 'none' });
  });

  it('opts in to the full article on press', () => {
    const s = step(summary, ctx(), 'press');
    expect(s.route).toEqual({ name: 'reader', view: 'today', id: 'a', page: 0, back: 2 });
    expect(s.effect).toEqual({ kind: 'openReader', id: 'a' });
  });

  it('archives from the menu action, back to the list when nothing follows', () => {
    const s = step(summary, ctx(), 'archive');
    expect(s.effect).toEqual({ kind: 'archive', id: 'a', refreshFeed: false });
    expect(s.route).toEqual({ name: 'list', view: 'today', focus: 2 });
  });

  it('uses double press as a safe back action', () => {
    expect(step(summary, ctx(), 'double')).toEqual({
      route: { name: 'list', view: 'today', focus: 2 },
      effect: { kind: 'none' },
    });
  });
});

describe('reader', () => {
  const reader: Route = { name: 'reader', view: 'today', id: 'a', page: 0, back: 0 };
  const long = ctx([], 41);

  it('advances a page per swipe and saves the position', () => {
    const s = step(reader, long, 'down');
    expect(s.route).toMatchObject({ page: 1 });
    expect(s.effect).toEqual({ kind: 'savePosition', id: 'a', page: 1 });
  });

  // Clamping, not wrapping: running off the end of a long article must stop
  // there. Jumping to the first sheet reads as data loss.
  it('clamps at the last sheet rather than wrapping', () => {
    const s = step({ ...reader, page: 40 }, long, 'down');
    expect(s.route).toMatchObject({ page: 40 });
  });

  // The firmware reports a swipe at the bottom only once the last line is on
  // screen, so this is the one moment every line has provably been shown.
  it('marks the article finished on a swipe past the end of the last sheet', () => {
    const last = { ...reader, page: 40 };
    expect(step(last, long, 'down')).toEqual({ route: last, effect: { kind: 'finished', id: 'a' } });
  });

  it('clamps at the first page', () => {
    const s = step(reader, long, 'up');
    expect(s.route).toMatchObject({ page: 0 });
    expect(s.effect).toEqual({ kind: 'none' });
  });

  it('returns to the summary on press', () => {
    expect(step({ ...reader, page: 5 }, long, 'press').route)
      // page: 0 — back from the reader lands on the TOP of the summary, not
      // wherever the reader happened to be.
      .toEqual({ name: 'summary', view: 'today', id: 'a', back: 0, page: 0 });
  });

  it('returns to the list on double press', () => {
    expect(step({ ...reader, back: 3 }, long, 'double').route)
      .toEqual({ name: 'list', view: 'today', focus: 3 });
  });

  it('archives from the native action menu', () => {
    const s = step({ ...reader, back: 3 }, long, 'archive');
    expect(s.route).toEqual({ name: 'list', view: 'today', focus: 3 });
    expect(s.effect).toEqual({ kind: 'archive', id: 'a', refreshFeed: false });
  });

  it('handles a single-sheet article without moving', () => {
    const s = step(reader, ctx([], 1), 'down');
    expect(s.route).toBe(reader);
    expect(s.effect).toEqual({ kind: 'finished', id: 'a' });
    expect(step(reader, ctx([], 1), 'up')).toEqual({ route: reader, effect: { kind: 'none' } });
  });
});

describe('opening the reader resumes where the article was left', () => {
  const summary: Route = { name: 'summary', view: 'halfread', id: 'a', back: 0, page: 0 };

  it('opens at the resume sheet the shell measured', () => {
    const s = step(summary, withCtx({ resumePage: 7 }), 'press');
    expect(s.route).toMatchObject({ name: 'reader', page: 7 });
  });

  it('opens at the top when nothing is known yet', () => {
    expect(step(summary, withCtx({ resumePage: 0 }), 'press').route).toMatchObject({ page: 0 });
  });
});

/**
 * Hold: the one-gesture archive the reading screens were missing. The menu
 * route to Archive is tap, hold, swipe, tap — and it then dropped the user
 * back on the list, one more press away from the next article.
 */
describe('hold archives and moves on', () => {
  const rows = [doc('a'), doc('b'), doc('c')];
  const summary: Route = { name: 'summary', view: 'recent', id: 'a', back: 0, page: 1 };

  it('opens the next article in the list, at the top of its summary', () => {
    const s = step(summary, ctx(rows), 'hold');
    // back: 0 — the archived row is pruned, so the next one moves up into it.
    expect(s.route).toEqual({ name: 'summary', view: 'recent', id: 'b', back: 0, page: 0 });
    expect(s.effect).toEqual({ kind: 'archive', id: 'a', refreshFeed: false, next: 'b' });
  });

  it('moves on from the reader to the next SUMMARY, not the next reader', () => {
    const reader: Route = { name: 'reader', view: 'recent', id: 'b', back: 1, page: 9 };
    const s = step(reader, ctx(rows, 20), 'hold');
    expect(s.route).toEqual({ name: 'summary', view: 'recent', id: 'c', back: 1, page: 0 });
    expect(s.effect).toMatchObject({ kind: 'archive', id: 'b', next: 'c' });
  });

  it('finds the next row by ID, not by the index the article was opened at', () => {
    // The list can shift under an open article — a failed archive keeps a row.
    const s = step({ ...summary, id: 'b', back: 0 }, ctx(rows), 'hold');
    expect(s.route).toMatchObject({ id: 'c', back: 1 });
  });

  it('goes back to the list after the last article', () => {
    const s = step({ ...summary, id: 'c', back: 2 }, ctx(rows), 'hold');
    expect(s.route).toEqual({ name: 'list', view: 'recent', focus: 2 });
    expect(s.effect).toEqual({ kind: 'archive', id: 'c', refreshFeed: false });
  });

  it('does the same from the menu action', () => {
    expect(step(summary, ctx(rows), 'archive')).toEqual(step(summary, ctx(rows), 'hold'));
  });

  it('moves on within a Feed section, marking the gap for a later refill', () => {
    const sections = [{ docs: [doc('x')] }, { docs: [doc('a'), doc('b')] }];
    const fromFeed: Route = {
      name: 'summary', view: 'today', id: 'a', back: 0, page: 0,
      origin: { kind: 'section', section: 1 },
    };
    const s = step(fromFeed, ctx([], 1, 1, sections), 'hold');
    expect(s.route).toEqual({ ...fromFeed, id: 'b', back: 0 });
    expect(s.effect).toEqual({ kind: 'archive', id: 'a', refreshFeed: true, next: 'b' });
  });

  it('returns to the digest after the last article of a Feed section', () => {
    const sections = [{ docs: [doc('x')] }, { docs: [doc('a')] }];
    const fromFeed: Route = {
      name: 'reader', view: 'today', id: 'a', back: 0, page: 0,
      origin: { kind: 'section', section: 1 },
    };
    const s = step(fromFeed, ctx([], 1, 1, sections), 'hold');
    // The section empties and is pruned, so there is no section to go back to.
    expect(s.route).toEqual({ name: 'digest', focus: 1 });
    expect(s.effect).toEqual({ kind: 'archive', id: 'a', refreshFeed: true });
  });
});

/**
 * A plain hold now reaches the app. Every list case used to treat any input
 * that was not a swipe or double as a PRESS — a hold on a list would open an
 * article, and a stray menu archive would too.
 */
describe('only a press opens', () => {
  const rows = [doc('a'), doc('b')];
  const sections = [{ docs: rows }];
  const cases: Array<[string, Route, NavContext]> = [
    ['home', { name: 'home', focus: 0 }, ctx(rows)],
    ['list', { name: 'list', view: 'recent', focus: 0 }, ctx(rows)],
    ['digest', { name: 'digest', focus: 0 }, ctx([], 1, 1, sections)],
    ['section', { name: 'section', section: 0, focus: 0 }, ctx([], 1, 1, sections)],
  ];

  for (const [name, route, c] of cases) {
    it(`hold and archive do nothing on ${name}`, () => {
      expect(step(route, c, 'hold')).toEqual({ route, effect: { kind: 'none' } });
      expect(step(route, c, 'archive')).toEqual({ route, effect: { kind: 'none' } });
    });
  }
});

describe('Feed picks are refilled when the digest is looked at', () => {
  const sections = [{ docs: [doc('a')] }];

  it('refills on the way back up from a section', () => {
    const s = step({ name: 'section', section: 0, focus: 0 },
      withCtx({ sections, digestLoaded: true, digestStale: true }), 'double');
    expect(s.route).toEqual({ name: 'digest', focus: 0 });
    expect(s.effect).toEqual({ kind: 'loadDigest', refresh: true });
  });

  it('refills when Feed is opened from the menu', () => {
    const s = step({ name: 'home', focus: 0 },
      withCtx({ sections, digestLoaded: true, digestStale: true }), 'navFeed');
    expect(s.effect).toEqual({ kind: 'loadDigest', refresh: true });
  });

  it('costs nothing when no archive left a gap', () => {
    expect(step({ name: 'section', section: 0, focus: 0 },
      withCtx({ sections, digestLoaded: true }), 'double').effect).toEqual({ kind: 'none' });
  });
});

describe('nextAfter', () => {
  const docs = [doc('a'), doc('b'), doc('c')];

  it('is the row below, landing where the archived row was', () => {
    expect(nextAfter(docs, 'a')).toEqual({ doc: docs[1], index: 0 });
    expect(nextAfter(docs, 'b')).toEqual({ doc: docs[2], index: 1 });
  });

  it('is nothing at the end of the list, or for an article not in it', () => {
    expect(nextAfter(docs, 'c')).toBeNull();
    expect(nextAfter(docs, 'zzz')).toBeNull();
    expect(nextAfter([], 'a')).toBeNull();
  });
});

describe('repointFocus — the rows changed under the route', () => {
  const before = [doc('a'), doc('b'), doc('c'), doc('d')];
  // 'b' is gone; everything after it moved up one.
  const after = [doc('a'), doc('c'), doc('d')];

  it('keeps a list focused on the same document', () => {
    expect(repointFocus({ name: 'list', view: 'recent', focus: 2 }, before, after))
      .toEqual({ name: 'list', view: 'recent', focus: 1 });
  });

  it('clamps a list whose focused document is gone', () => {
    expect(repointFocus({ name: 'list', view: 'recent', focus: 1 }, before, after))
      .toMatchObject({ focus: 1 });
    expect(repointFocus({ name: 'list', view: 'recent', focus: 3 }, before, [doc('a')]))
      .toMatchObject({ focus: 0 });
  });

  // Reader → double used to land on `back`, an index into rows that no
  // longer existed in that order.
  it('re-points where an open article goes back to, through the reader too', () => {
    const summary: Route = { name: 'summary', view: 'recent', id: 'd', back: 3, page: 0 };
    expect(repointFocus(summary, before, after)).toEqual({ ...summary, back: 2 });
    const reader: Route = { name: 'reader', view: 'recent', id: 'c', back: 2, page: 4 };
    expect(repointFocus(reader, before, after)).toEqual({ ...reader, back: 1 });
  });

  it('leaves an article opened from a Feed section alone — that list did not change', () => {
    const fromSection: Route = {
      name: 'summary', view: 'today', id: 'x', back: 2, page: 0, origin: { kind: 'section', section: 1 },
    };
    expect(repointFocus(fromSection, before, after)).toBe(fromSection);
  });

  // An article opened from an answer goes back to the answer list (its `back`
  // indexes answer documents, unchanged) — but the list the question was
  // asked from sits behind that, and it did change.
  it('keeps an answer article\'s back index and re-points the list behind the question', () => {
    const list: Route = { name: 'list', view: 'recent', focus: 3 };
    const fromAnswer: Route = {
      name: 'reader', view: 'recent', id: 'p1', back: 1, page: 2, origin: { kind: 'answers', from: list },
    };
    expect(repointFocus(fromAnswer, before, after)).toEqual({
      ...fromAnswer, origin: { kind: 'answers', from: { name: 'list', view: 'recent', focus: 2 } },
    });
  });

  it('follows the chain a question returns to', () => {
    const list: Route = { name: 'list', view: 'recent', focus: 3 };
    const ask: Route = { name: 'ask', phase: 'answer', page: 0, from: list };
    const answers: Route = { name: 'answers', focus: 1, from: ask };
    expect(repointFocus(answers, before, after)).toEqual({
      name: 'answers', focus: 1,
      from: { name: 'ask', phase: 'answer', page: 0, from: { name: 'list', view: 'recent', focus: 2 } },
    });
  });

  it('leaves home, the digest and a section untouched', () => {
    for (const r of [{ name: 'home', focus: 2 }, { name: 'digest', focus: 1 }, { name: 'section', section: 0, focus: 2 }] as Route[]) {
      expect(repointFocus(r, before, after)).toBe(r);
    }
  });
});

describe('refresh from the menu', () => {
  // The library is a 15-minute cache and nothing polls: this is the one way to
  // see a save made on the phone a moment ago. The screen stays where it is.
  it('asks for a refresh from any screen without moving', () => {
    const routes: Route[] = [
      { name: 'home', focus: 2 },
      { name: 'list', view: 'recent', focus: 1 },
      { name: 'digest', focus: 0 },
      { name: 'summary', view: 'recent', id: 'a', back: 0, page: 0 },
    ];
    for (const r of routes) {
      expect(step(r, THREE, 'navRefresh')).toEqual({ route: r, effect: { kind: 'refresh' } });
    }
  });
});

describe('offline', () => {
  it('retries on press and exits on double', () => {
    const off: Route = { name: 'offline' };
    expect(step(off, ctx(), 'press').effect).toEqual({ kind: 'refresh' });
    expect(step(off, ctx(), 'double').effect).toEqual({ kind: 'exit' });
    expect(step(off, ctx(), 'down').effect).toEqual({ kind: 'none' });
  });
});


describe('asking the library', () => {
  const list: Route = { name: 'list', view: 'recent', focus: 2 };
  const listening: Route = { name: 'ask', phase: 'listening', page: 0, from: list };
  const picks = [doc('p1'), doc('p2'), doc('p3')];

  it('starts from the menu on any screen, returning there when done', () => {
    expect(step(list, ctx(), 'navAsk')).toEqual({ route: listening, effect: { kind: 'listen' } });
  });

  it('sends on press — the pause detector sends too, from the shell', () => {
    expect(step(listening, ctx(), 'press')).toEqual({
      route: { ...listening, phase: 'transcribing' },
      effect: { kind: 'sendQuestion' },
    });
  });

  it('cancels on double, closing the mic and going back where it was asked', () => {
    for (const phase of ['listening', 'transcribing', 'searching', 'answering'] as const) {
      expect(step({ ...listening, phase }, ctx(), 'double'))
        .toEqual({ route: list, effect: { kind: 'cancelAsk' } });
    }
  });

  it('waits out the Brain in the answering phase', () => {
    const answering: Route = { ...listening, phase: 'answering' };
    for (const g of ['press', 'up', 'down', 'hold'] as const) {
      expect(step(answering, ctx(), g)).toEqual({ route: answering, effect: { kind: 'none' } });
    }
  });

  it('ignores swipes and holds while listening', () => {
    for (const g of ['up', 'down', 'hold'] as const) {
      expect(step(listening, ctx(), g)).toEqual({ route: listening, effect: { kind: 'none' } });
    }
  });

  it('pages a long answer, clamped', () => {
    const answer: Route = { ...listening, phase: 'answer' };
    expect(step(answer, withCtx({ answerPages: 2 }), 'down').route).toEqual({ ...answer, page: 1 });
    const last = { ...answer, page: 1 };
    expect(step(last, withCtx({ answerPages: 2 }), 'down')).toEqual({ route: last, effect: { kind: 'none' } });
  });

  it('opens what the answer points at on press', () => {
    const answer: Route = { ...listening, phase: 'answer' };
    expect(step(answer, withCtx({ answerDocs: picks }), 'press').route)
      .toEqual({ name: 'answers', focus: 0, from: list });
  });

  it('asks again on press when the answer points at nothing', () => {
    const answer: Route = { ...listening, phase: 'answer' };
    expect(step(answer, ctx(), 'press')).toEqual({ route: listening, effect: { kind: 'listen' } });
  });

  it('retries from an error on press, and leaves on double', () => {
    const error: Route = { ...listening, phase: 'error' };
    expect(step(error, ctx(), 'press').effect).toEqual({ kind: 'listen' });
    expect(step(error, ctx(), 'double').route).toEqual(list);
  });

  it('opens an answer\'s document as a summary that returns to the answers', () => {
    const answers: Route = { name: 'answers', focus: 1, from: list };
    const s = step(answers, withCtx({ answerDocs: picks }), 'press');
    expect(s.route).toMatchObject({ name: 'summary', id: 'p2', back: 1, origin: { kind: 'answers', from: list } });
    expect(s.effect).toEqual({ kind: 'openSummary', id: 'p2' });
    expect(step(s.route, withCtx({ answerDocs: picks }), 'double').route).toEqual(answers);
  });

  it('backs out of the answers to the answer', () => {
    expect(step({ name: 'answers', focus: 0, from: list }, withCtx({ answerDocs: picks }), 'double').route)
      .toEqual({ name: 'ask', phase: 'answer', page: 0, from: list });
  });

  it('holds to archive and moves on through the answers', () => {
    const summary: Route = {
      name: 'summary', view: 'recent', id: 'p1', back: 0, page: 0,
      origin: { kind: 'answers', from: list },
    };
    const s = step(summary, withCtx({ answerDocs: picks }), 'hold');
    expect(s.route).toMatchObject({ name: 'summary', id: 'p2', origin: { kind: 'answers', from: list } });
    expect(s.effect).toEqual({ kind: 'archive', id: 'p1', refreshFeed: false, next: 'p2' });
  });

  // Asking again from inside the flow must not nest: backing out still lands
  // where the FIRST question was asked, not on the previous answer.
  it('never nests one question inside another', () => {
    const fromAnswer = step({ ...listening, phase: 'answer' }, ctx(), 'navAsk').route;
    expect(fromAnswer).toEqual(listening);
    const fromPickedArticle = step({
      name: 'reader', view: 'recent', id: 'p1', page: 3, back: 0, origin: { kind: 'answers', from: list },
    }, ctx(), 'navAsk').route;
    expect(fromPickedArticle).toEqual(listening);
  });
});

/**
 * A Brain summary is a Claude session on the mini. When every open asked for
 * one, swiping through a list started a session per row (2026-11-19). Only the
 * menu's "Summarise" asks now.
 */
describe('summaries are asked for, never assumed', () => {
  const card: Route = { name: 'summary', view: 'recent', id: 'b', back: 1, page: 0 };

  it('opening an article loads it and nothing more', () => {
    const s = step({ name: 'list', view: 'recent', focus: 1 }, THREE, 'press');
    expect(s.effect).toEqual({ kind: 'openSummary', id: 'b' });
  });

  it('archive & next opens the next article without summarising it', () => {
    expect(step(card, THREE, 'hold').effect).toEqual({
      kind: 'archive', id: 'b', refreshFeed: false, next: 'c',
    });
  });

  it('summarise asks for the open article and keeps the page where it is', () => {
    const s = step(card, THREE, 'summarise');
    expect(s.route).toBe(card);
    expect(s.effect).toEqual({ kind: 'summarise', id: 'b' });
  });

  it('summarise means nothing anywhere else', () => {
    const reader: Route = { name: 'reader', view: 'recent', id: 'b', page: 2, back: 1 };
    for (const r of [reader, { name: 'list', view: 'recent', focus: 0 } as Route]) {
      expect(step(r, THREE, 'summarise')).toEqual({ route: r, effect: { kind: 'none' } });
    }
  });
});
