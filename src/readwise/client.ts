/**
 * Readwise Reader API client.
 *
 * Every shape here was verified against the LIVE API on 2026-08-06, not read
 * off the reference. Two findings contradict the published docs and are
 * encoded below rather than left as folklore:
 *
 *   1. `withHtmlContent=true` returns **`html_content`**. The documented
 *      `content` field is ALWAYS null. Reading `content` yields an empty
 *      article and no error — a silent failure, which is why `fullText()`
 *      reads `html_content` and treats a null as a hard error.
 *
 *   2. Ghostreader has no endpoint. The `summary` field is populated on every
 *      document, but it is the PUBLISHER's blurb (one sample was a verbatim
 *      Guardian standfirst), not AI output. So the Brain writes summaries —
 *      see `brain/summarise.ts`. Never present `summary` as a Brain summary.
 *
 * Two more, verified against the live API on 2026-09-24:
 *
 *   3. `reading_progress` CANNOT be written. `PATCH /update/<id>/` with it
 *      returns 200 `{id, url}` and changes nothing — the docs do not list it,
 *      and the local stand-in had accepted it, which is how every progress
 *      write this app made went nowhere without an error. It is read-only here;
 *      Reader's own apps are the only writers.
 *
 *   4. `reading_time` is a STRING — "13 mins" — not a number. Rendering it as
 *      `${reading_time} min` printed "13 mins min". Read it via
 *      `readingMinutes()`.
 *
 * RATE LIMIT IS THE DESIGN CONSTRAINT: 20 requests/minute on list and text,
 * 50/min on update. A naive implementation 429s on first real use, so this
 * module caches aggressively and NEVER polls. Callers fetch a list once per
 * session and article text on demand.
 */

export const BASE = 'https://readwise.io/api/v3';

/**
 * Where API calls actually go.
 *
 * Overridable so the app can be driven against a local stand-in during
 * development — the alternative is testing the real reading flow against a
 * live 20-requests/minute budget, which burns through it in a few passes and
 * leaves the app 429ing for the rest of the session.
 *
 * Read from the environment at BUILD time, so a packaged .ehpk can only ever
 * point at readwise.io. There is no runtime switch to misconfigure.
 */
export const apiBase = (): string =>
  (import.meta.env?.VITE_READWISE_BASE as string | undefined) ?? BASE;

/** Beyond this the user assumes it is broken, so we should too. */
const TIMEOUT_MS = 12_000;

/**
 * Documents we can actually render. PDFs, videos, tweets and epubs are
 * filtered out — they do not read at 576×288 and were never the point.
 */
export type Category = 'article';

export type Location = 'new' | 'later' | 'archive' | 'feed';

export type Doc = {
  id: string;
  title: string;
  author: string | null;
  /** Publication, e.g. "The Guardian". Often null on self-published pages. */
  site_name: string | null;
  /** How the document entered Reader, e.g. "Reader RSS" or web highlighter. */
  source?: string | null;
  url: string;
  category: string;
  location: Location;
  /** 0..1. Written by Reader's own apps; READ-ONLY through this API (see 3). */
  reading_progress: number;
  /**
   * Readwise's estimate as display text — "13 mins" (see 4). Null on documents
   * it could not parse. Use `readingMinutes()`, never the raw value.
   */
  reading_time: string | null;
  /** ISO 8601. */
  saved_at: string;
  /** The PUBLISHER's blurb — NOT an AI summary. See the module note. */
  summary: string | null;
  /** Only present when requested with `withHtmlContent`. */
  html_content?: string | null;
};

export type ListPage = {
  results: Doc[];
  nextPageCursor: string | null;
};

export class ReadwiseError extends Error {
  // Declared explicitly rather than as a parameter property: the project runs
  // with `erasableSyntaxOnly`, which forbids that shorthand.
  readonly kind: 'auth' | 'rate' | 'network' | 'timeout' | 'server' | 'data';
  constructor(message: string, kind: ReadwiseError['kind']) {
    super(message);
    this.kind = kind;
  }
}

/**
 * Human-facing sentence for a failure. The HUD has no room for a stack trace
 * and no console — whatever this returns IS the entire error experience.
 */
export function explain(e: unknown): string {
  if (e instanceof ReadwiseError) {
    switch (e.kind) {
      case 'auth': return 'Readwise token rejected. Check it on the phone.';
      case 'rate': return 'Readwise rate limit — wait a minute.';
      case 'timeout': return 'Readwise did not answer in time.';
      case 'network': return 'No connection to Readwise.';
      case 'data': return e.message;
      default: return e.message;
    }
  }
  return 'Something went wrong reaching Readwise.';
}

export type Fetcher = typeof fetch;

export type ClientOptions = {
  token: string;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: Fetcher;
  /** Injected so cache-expiry tests need no real clock. */
  now?: () => number;
};

async function call<T>(opts: ClientOptions, path: string, init?: RequestInit): Promise<T> {
  const f = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await f(apiBase() + path, {
      ...init,
      signal: ctrl.signal,
      headers: {
        Authorization: `Token ${opts.token}`,
        ...(init?.headers ?? {}),
      },
    });
    if (res.status === 401 || res.status === 403) {
      throw new ReadwiseError('Token rejected', 'auth');
    }
    // 429 is not exceptional here — it is the expected consequence of the
    // 20/min budget, so it gets its own kind and its own user-facing sentence.
    if (res.status === 429) {
      throw new ReadwiseError('Rate limited', 'rate');
    }
    if (!res.ok) {
      throw new ReadwiseError(`Readwise HTTP ${res.status}`, 'server');
    }
    // 204/empty body would throw an opaque JSON parse error otherwise.
    const text = await res.text();
    if (!text) throw new ReadwiseError('Readwise returned an empty response', 'data');
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ReadwiseError('Readwise returned malformed JSON', 'data');
    }
  } catch (e) {
    if (e instanceof ReadwiseError) throw e;
    if ((e as Error).name === 'AbortError') {
      throw new ReadwiseError(`No answer from Readwise in ${TIMEOUT_MS / 1000}s`, 'timeout');
    }
    throw new ReadwiseError((e as Error).message || 'Cannot reach Readwise', 'network');
  } finally {
    clearTimeout(timer);
  }
}

/** Build a `GET /list/` query. Exported so tests can assert the exact URL. */
export function listQuery(params: {
  location?: Location;
  category?: Category;
  updatedAfter?: string;
  pageCursor?: string;
  withHtmlContent?: boolean;
  id?: string;
}): string {
  const q = new URLSearchParams();
  if (params.id) q.set('id', params.id);
  if (params.location) q.set('location', params.location);
  if (params.category) q.set('category', params.category);
  if (params.updatedAfter) q.set('updatedAfter', params.updatedAfter);
  if (params.pageCursor) q.set('pageCursor', params.pageCursor);
  // Only ever sent as `true`. Sending `false` still costs the same request but
  // Readwise treats any presence as opt-in, so we omit it instead.
  if (params.withHtmlContent) q.set('withHtmlContent', 'true');
  const s = q.toString();
  return `/list/${s ? `?${s}` : ''}`;
}

/** One page of documents. Callers page explicitly — nothing here loops. */
export const listPage = (
  opts: ClientOptions,
  params: Parameters<typeof listQuery>[0],
): Promise<ListPage> => call<ListPage>(opts, listQuery(params));

/**
 * All documents at a location, following the cursor.
 *
 * `maxPages` is a hard stop, not a suggestion: `feed` holds 10,000 items and
 * an unbounded loop would burn the entire 20/min budget and still not finish.
 * Callers that need everything should be paging on the phone, not the glasses.
 */
export async function listAll(
  opts: ClientOptions,
  params: Parameters<typeof listQuery>[0],
  maxPages = 3,
): Promise<Doc[]> {
  const out: Doc[] = [];
  let cursor: string | undefined = params.pageCursor;
  for (let i = 0; i < maxPages; i++) {
    const pageResult: ListPage = await listPage(opts, { ...params, pageCursor: cursor });
    out.push(...(pageResult.results ?? []));
    cursor = pageResult.nextPageCursor ?? undefined;
    if (!cursor) break;
  }
  return out;
}

/**
 * Full article text as HTML.
 *
 * Reads `html_content`, NOT `content`. See the module note — `content` is
 * always null, and reading it produced an empty reader with no error during
 * research. A null here is a real failure and says so.
 */
export async function fullText(opts: ClientOptions, id: string): Promise<string> {
  const pageResult = await listPage(opts, { id, withHtmlContent: true });
  const doc = pageResult.results?.[0];
  if (!doc) throw new ReadwiseError('Article not found', 'data');
  const html = doc.html_content;
  if (!html) {
    throw new ReadwiseError('No readable text for this article', 'data');
  }
  return html;
}

/**
 * The one write this app performs: `location=archive`. The card allowed two,
 * but `reading_progress` turned out not to be writable (see 3), so positions
 * are kept locally instead. No deletes, no tag mutation, no saving new
 * documents. Keep it that way.
 */
export const updateDoc = (
  opts: ClientOptions,
  id: string,
  patch: { location: 'archive' },
): Promise<Doc> =>
  call<Doc>(opts, `/update/${id}/`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });

export const archive = (opts: ClientOptions, id: string) =>
  updateDoc(opts, id, { location: 'archive' });

/**
 * Whole minutes from Readwise's `reading_time`, or null.
 *
 * The live API sends "13 mins". A number is accepted too — test fixtures and
 * libraries cached by the stand-in carry one — so every renderer can call this
 * without knowing where the document came from.
 */
export function readingMinutes(d: { reading_time: unknown }): number | null {
  const t = d.reading_time;
  if (typeof t === 'number') return Number.isFinite(t) && t > 0 ? Math.round(t) : null;
  if (typeof t !== 'string') return null;
  const m = t.match(/\d+/);
  return m && Number(m[0]) > 0 ? Number(m[0]) : null;
}
