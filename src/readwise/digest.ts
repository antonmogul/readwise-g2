/**
 * The feed digest — grouping, as pure functions.
 *
 * The feed is the acute problem the card names: 10,000 items, filling faster
 * than it can be read, effectively write-only. The three library views are
 * occasional value ("what did I save today", "what did I abandon"); this is the
 * one with DAILY value, which is why the card calls it "the strongest case for
 * AI in this whole app".
 *
 * Two things live here, and the split matters:
 *
 *   GROUPING is pure and always works. Feed items bucketed by publication,
 *   biggest section first. No network, no model, no failure mode.
 *   TRIAGE is the Brain's — see `brain/digest.ts`. It picks what is worth
 *   attention out of the grouping.
 *
 * When the Brain is unreachable the digest degrades to the grouping alone and
 * says so, exactly as `summarise.ts` degrades to an honest extract. A digest
 * that fails closed would take the daily surface down with the tailnet.
 *
 * WHAT THIS IS NOT: the whole feed. `listAll` caps at a few pages because an
 * unbounded loop over 10,000 items cannot finish inside 20 requests/minute, so
 * the digest covers the most RECENT slice. That is the right scope for "today's
 * titles", but nothing here should imply completeness.
 */

import type { Doc } from './client';
/** Feed-readable formats. Reader reports RSS and newsletters as their own
 * categories even though they contain the same article HTML we can render. */
export const isFeedReadable = (d: Doc): boolean =>
  d.category === 'article' || d.category === 'rss' || d.category === 'email';

/** Sections shown at once. Beyond this the digest is a list, not a digest. */
export const MAX_SECTIONS = 6;

/** Titles listed under a section on the glasses. */
export const MAX_PER_SECTION = 5;

export type Section = {
  /** Publication, or the bucket name the Brain chose. */
  name: string;
  docs: Doc[];
  /** The Brain's one-line reason this section is worth attention, when it ran. */
  note: string | null;
};

export type Digest = {
  sections: Section[];
  /** True when the Brain triaged this; false when it is grouping alone. */
  fromBrain: boolean;
  /** Total feed items considered, which is NOT the size of the feed. */
  considered: number;
};

/** Publication, falling back to a bucket that is honest about being unknown. */
export const publicationOf = (d: Doc): string => d.site_name?.trim() || 'Unattributed';

/**
 * Group feed items by publication, biggest section first.
 *
 * This is the fallback AND the input to triage, so it must never throw and must
 * never depend on the network. Ordering by size is the useful default without a
 * model: a publication that filed twelve pieces today is the one worth a look.
 */
export function groupByPublication(docs: Doc[], now: Date): Section[] {
  const fresh = docs.filter(isFeedReadable).filter((d) => isRecent(d.saved_at, now));
  const byName = new Map<string, Doc[]>();
  for (const d of fresh) {
    const key = publicationOf(d);
    const bucket = byName.get(key);
    if (bucket) bucket.push(d);
    else byName.set(key, [d]);
  }
  return [...byName.entries()]
    .map(([name, items]) => ({
      name,
      // Newest first inside a section, matching every other list in the app.
      docs: [...items]
        .sort((a, b) => new Date(b.saved_at).getTime() - new Date(a.saved_at).getTime())
        .slice(0, MAX_PER_SECTION),
      note: null,
    }))
    .sort((a, b) => b.docs.length - a.docs.length || a.name.localeCompare(b.name))
    .slice(0, MAX_SECTIONS);
}

/**
 * How far back "today's feed" reaches.
 *
 * A strict calendar day empties the digest every midnight and leaves it blank
 * all morning — the feed fills at the publishers' pace, not Anton's. 36 hours
 * always has a yesterday-evening tail in it while still reading as "recent".
 */
export const RECENT_HOURS = 36;

export function isRecent(iso: string, now: Date): boolean {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  const age = now.getTime() - t;
  // Future timestamps are clock skew, not a reason to hide an item.
  return age < RECENT_HOURS * 3_600_000;
}

/**
 * Apply the Brain's triage to a grouping.
 *
 * The model returns section names and the doc IDs under them. Everything is
 * validated against the documents we actually hold: a hallucinated ID names no
 * article and is dropped, and a section left with nothing is dropped with it.
 * The model chooses the ORDER and the reasoning; it cannot invent the content.
 */
export function applyTriage(
  docs: Doc[],
  picks: Array<{ name: string; ids: string[]; note?: string | null }>,
): Section[] {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const sections: Section[] = [];
  for (const pick of picks.slice(0, MAX_SECTIONS)) {
    const chosen = pick.ids
      .map((id) => byId.get(id))
      .filter((d): d is Doc => Boolean(d))
      .slice(0, MAX_PER_SECTION);
    if (chosen.length === 0) continue;
    sections.push({
      name: pick.name?.trim() || 'Worth a look',
      docs: chosen,
      note: pick.note?.trim() || null,
    });
  }
  return sections;
}

/** Every document in a digest, in render order — what the list screen shows. */
export const digestDocs = (d: Digest): Doc[] => d.sections.flatMap((s) => s.docs);

/** One line per section on the glasses: name, count, and the Brain's reason. */
export function sectionLabel(s: Section): string {
  const count = `${s.docs.length}`;
  return s.note ? `${s.name} (${count}) — ${s.note}` : `${s.name} (${count})`;
}

export const EMPTY_DIGEST_MESSAGE = 'Nothing new in the feed.';
