// Local stand-in for the Readwise Reader API and the Brain board.
//
// The real reading flow — sheets, progress writes, hold-to-archive, the Feed
// refill — cannot be exercised against readwise.io without spending the
// 20 req/min budget in a few passes. This serves a small library, a Feed, long
// articles with curly quotes (they are three bytes each, which is what the
// sheet budget counts), a slow Brain summary, and a triage reply. Every request
// is logged, so a write can be checked rather than assumed.
//
//   npm run standin                         # :4999, summaries take 3s
//   ASK_DELAY_MS=60000 npm run standin      # a realistic Claude turn
//
// Then run the app against it (these are read at BUILD time — see README):
//
//   VITE_READWISE_BASE=http://127.0.0.1:4999/api/v3 \
//   VITE_BOARD_BASE=http://127.0.0.1:4999 VITE_READWISE_TOKEN=dev-token \
//   npx vite --host 0.0.0.0
//
// DEMO=1 serves an invented library with real prose (scripts/demo-content.mjs)
// for screenshots and videos. /v1/messages stands in for Anthropic, so the
// reader's-own-key flow can be driven without spending credit — point the app
// at it with VITE_ANTHROPIC_BASE=http://127.0.0.1:4999 and give it
// VITE_CLAUDE_SETTINGS='{"apiKey":"dev-token","model":"claude-opus-5-5"}'.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { DEMO_LIBRARY, DEMO_FEED, DEMO_TRIAGE } from './demo-content.mjs';

const DEMO = process.env.DEMO === '1';

const PORT = Number(process.env.PORT ?? 4999);
const ASK_DELAY_MS = Number(process.env.ASK_DELAY_MS ?? 3000);

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();

const demoLibrary = DEMO_LIBRARY.map((d, i) => ({
  id: d.id, title: d.title, author: d.author, site_name: d.site, source: 'Readwise web highlighter',
  url: `https://read.readwise.io/read/${d.id}`, source_url: `https://example.com/${d.id}`,
  category: 'article', location: d.location, reading_progress: d.progress, reading_time: `${d.mins} mins`,
  saved_at: iso(i * 0.7), summary: d.blurb,
}));

const demoFeed = DEMO_FEED.map((d, i) => ({
  id: d.id, title: d.title, author: null, site_name: d.site, source: 'Reader RSS',
  url: `https://read.readwise.io/read/${d.id}`, source_url: `https://example.com/${d.id}`,
  category: 'rss', location: 'feed', reading_progress: 0, reading_time: `${4 + (i % 5)} mins`,
  saved_at: iso(i * 0.1), summary: null,
}));

const testLibrary = [
  ['lib1', 'The grid cannot carry the data centres we keep approving', 'The Guardian', 'Jane Doe', 14, 0, 'later'],
  ['lib2', 'Why attention markets eat the focus they sell', 'The Atlantic', 'Cal Newport', 11, 0.42, 'later'],
  ['lib3', 'A short note on long documents', 'Stratechery', 'Ben Thompson', 3, 0, 'new'],
  ['lib4', 'What the council vote actually changes', 'BBC News', null, 6, 0, 'later'],
  ['lib5', 'Notes on building for 576 by 288 pixels', 'Even Realities Blog', 'Staff', 9, 0.2, 'later'],
].map(([id, title, site, author, mins, progress, location], i) => ({
  // Shapes as the live API sends them (verified 2026-09-24): `url` is the
  // Reader link, the original is `source_url`, and reading_time is TEXT.
  id, title, author, site_name: site, source: 'Readwise web highlighter',
  url: `https://read.readwise.io/read/${id}`, source_url: `https://example.com/${id}`,
  category: 'article', location, reading_progress: progress, reading_time: `${mins} mins`,
  saved_at: iso(i), summary: 'Publisher blurb — NOT an AI summary.',
}));

const testFeed = Array.from({ length: 8 }, (_, i) => ({
  id: `feed${i}`, title: `Feed item ${i}: ${['Chip export rules tighten again', 'A new battery chemistry claims 2x density', 'Cities trial congestion pricing', 'The quiet return of the fax machine'][i % 4]}`,
  author: null, site_name: ['The Verge', 'Ars Technica', 'FT', 'Wired'][i % 4], source: 'Reader RSS',
  url: `https://read.readwise.io/read/feed${i}`, source_url: `https://example.com/feed${i}`,
  category: 'rss', location: 'feed', reading_progress: 0,
  reading_time: 4 + i, saved_at: iso(0), summary: null,
}));

const library = DEMO ? demoLibrary : testLibrary;
const feed = DEMO ? demoFeed : testFeed;

/** What /api/transcribe hears. */
const TRANSCRIPT = process.env.STANDIN_TRANSCRIPT ?? 'find me something short to read about cities';

/** 16 kHz s16le mono: half a second of room, two seconds of "voice", a breath. */
function toneQuestion() {
  const rate = 16000;
  const pcm = Buffer.alloc(rate * 2 * 2.8);
  for (let i = rate * 0.5; i < rate * 2.5; i++) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 0.25 * 32767), i * 2);
  }
  return pcm;
}
const MIC_PCM = process.env.STANDIN_MIC_PCM ? readFileSync(process.env.STANDIN_MIC_PCM) : toneQuestion();

const archived = new Set();

/** A document as it stands after the writes this server has accepted. */
const current = (d) => ({
  ...d,
  location: archived.has(d.id) ? 'archive' : d.location,
});

function articleHtml(id) {
  const demo = DEMO_LIBRARY.find((d) => d.id === id);
  if (demo) return `<article><h1>${demo.title}</h1>${demo.html}</article>`;
  if (DEMO) return `<article><p>${(feed.find((d) => d.id === id) ?? {}).title ?? ''} — a short feed item.</p></article>`;
  const paras = Array.from({ length: 34 }, (_, p) => {
    const sentences = Array.from({ length: 3 + (p % 4) }, (_, s) =>
      `In paragraph ${p + 1}, sentence ${s + 1} of ${id} makes a “careful” point — about load, cost and who pays.`);
    return `<p>${sentences.join(' ')}</p>`;
  });
  return `<article><h1>Ignored heading</h1><script>var x = 1;</script>${paras.join('\n')}</article>`;
}

const SUMMARY = [
  'The operator promises to pay for a substation upgrade and cap its peak draw, which is what won the vote — but the same promise has been made, and renegotiated, at three other sites in the last five years.',
  'The piece argues the real constraint is not generation but distribution: the local network was sized for homes, and a single campus can double peak demand overnight. “Restraint at the planning stage” is cheap; enforcement two years later is not.',
  'Its conclusion is procedural rather than technical. Tie the cap to the connection agreement, publish the metering, and make renegotiation a public vote — otherwise the council has approved a load it cannot see.',
].join('\n\n');

function triageReply(docs) {
  const ids = docs.map((d) => d.id);
  return JSON.stringify({ sections: [
    { name: 'Policy and power', ids: ids.slice(0, 3), note: 'Grid and export rules' },
    { name: 'Things that got cheaper', ids: ids.slice(3, 6), note: null },
  ] });
}

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, {
    'content-type': type,
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS',
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  const body = raw.toString('utf8');
  const stamp = new Date().toISOString().slice(11, 23);
  console.log(`${stamp} ${req.method} ${url.pathname}${url.search} ${body.slice(0, 120)}`);
  if (req.method === 'OPTIONS') {
    // The Anthropic SDK sends a dozen headers; echo whatever the browser asks for.
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '*',
      'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS',
    });
    return res.end();
  }

  // ---- Anthropic, as the reader's own key reaches it (VITE_ANTHROPIC_BASE)
  if (url.pathname === '/v1/messages' && req.method === 'POST') {
    const msg = JSON.parse(body || '{}');
    const user = String(msg.messages?.[0]?.content ?? '');
    const system = String(msg.system ?? '');
    await new Promise((r) => setTimeout(r, ASK_DELAY_MS));
    let text;
    if (system.includes('Readwise feed')) {
      text = JSON.stringify(DEMO ? DEMO_TRIAGE : JSON.parse(triageReply(feed)));
    } else {
      const title = (user.match(/^Title: (.+)$/m) ?? [])[1];
      text = DEMO_LIBRARY.find((d) => d.title === title)?.summary ?? SUMMARY;
    }
    return send(res, 200, {
      id: 'msg_standin', type: 'message', role: 'assistant', model: msg.model,
      content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  }

  if (url.pathname === '/api/v3/list/') {
    const id = url.searchParams.get('id');
    if (id) {
      const doc = [...library, ...feed].find((d) => d.id === id);
      if (!doc) return send(res, 200, { count: 0, nextPageCursor: null, results: [] });
      return send(res, 200, { count: 1, nextPageCursor: null, results: [{ ...current(doc), html_content: articleHtml(id) }] });
    }
    const location = url.searchParams.get('location');
    const pool = location === 'feed' ? feed : library.filter((d) => d.location === location);
    const results = pool.filter((d) => !archived.has(d.id)).map(current);
    return send(res, 200, { count: results.length, nextPageCursor: null, results });
  }

  const update = url.pathname.match(/^\/api\/v3\/update\/([^/]+)\/$/);
  if (update && req.method === 'PATCH') {
    const patch = JSON.parse(body || '{}');
    const doc = [...library, ...feed].find((d) => d.id === update[1]);
    if (!doc) return send(res, 404, { detail: 'not found' });
    if (patch.location === 'archive') archived.add(doc.id);
    // Like the live API: 200, and `reading_progress` IGNORED. Accepting it here
    // is how every progress write the app made hid for weeks.
    console.log(`        -> ${doc.id} ${patch.location ? 'ARCHIVED' : 'progress IGNORED (as the live API does)'}`);
    return send(res, 200, { id: doc.id, url: doc.url });
  }

  // ---- a Brain board, as the app uses it

  if (url.pathname === '/api/transcribe' && req.method === 'POST') {
    if (!raw.length) return send(res, 400, { error: 'no audio' });
    if (raw.length > 2_000_000) return send(res, 413, { error: 'audio too long' });
    console.log(`        -> ${raw.length} bytes of PCM (${(raw.length / 32000).toFixed(1)}s)`);
    return send(res, 200, { ok: true, text: TRANSCRIPT });
  }

  if (url.pathname === '/api/library/search' && req.method === 'POST') {
    const query = String(JSON.parse(body || '{}').query ?? '').toLowerCase();
    const words = query.split(/\W+/).filter((w) => w.length >= 4);
    const pool = [...library, ...feed].filter((d) => !archived.has(d.id));
    const hits = pool.filter((d) => words.some((w) => d.title.toLowerCase().includes(w)));
    const documents = (hits.length ? hits : pool.slice(0, 3)).slice(0, 5).map((d) => ({
      id: d.id, title: d.title, author: d.author, category: d.category,
      passages: [`In paragraph 2, ${d.id} makes a “careful” point — about load, cost and who pays.`],
    }));
    return send(res, 200, { ok: true, documents, highlights: [
      { text: 'Cities have historically driven politics, culture, technology.', note: null, title: 'Rethink: The Future of Cities', author: 'Rethink' },
    ] });
  }

  // A recorded question for the simulator, which has no mic (VITE_FAKE_MIC).
  // STANDIN_MIC_PCM serves a real one (16 kHz s16le mono) — for the live
  // board's whisper; without it, a tone stands in for a voice.
  if (url.pathname === '/dev/mic.pcm') {
    return send(res, 200, MIC_PCM, 'application/octet-stream');
  }

  if (url.pathname === '/api/ask' && req.method === 'POST') {
    // As the live board: no provider, no answer (this is the check the old
    // stand-in lacked, and the reason no summary ever reached the glasses).
    const provider = url.searchParams.get('provider');
    if (provider !== 'claude' && provider !== 'codex') {
      return send(res, 400, { error: 'provider must be explicitly set to codex or claude' });
    }
    const mode = url.searchParams.get('mode');
    const q = JSON.parse(body || '{}').question ?? '';
    const reply = async (text) => send(res, 200, mode === 'text'
      ? { provider, mode, reply: text }
      : { transcript: q, provider, reply: text });
    if (q.startsWith('Summarise')) {
      await new Promise((r) => setTimeout(r, ASK_DELAY_MS));
      return reply(SUMMARY);
    }
    if (q.startsWith('Anton asked his Readwise library')) {
      await new Promise((r) => setTimeout(r, Math.min(ASK_DELAY_MS, 2000)));
      const ids = [...new Set([...q.matchAll(/^\[([\w-]+)\]/gm)].map((m) => m[1]))];
      const known = [...library, ...feed].filter((d) => ids.includes(d.id)).slice(0, 2);
      return reply(JSON.stringify({
        answer: `Two fit. ${known.map((d) => d.title).join(' — or — ') || 'Nothing in your library covers that.'}`,
        documents: known.map((d, i) => ({ id: d.id, why: i ? 'short and on topic' : 'the closest match' })),
      }));
    }
    return reply(triageReply(feed.filter((d) => !archived.has(d.id))));
  }

  send(res, 404, { detail: 'unknown route' });
}).listen(PORT, '127.0.0.1', () => console.log(`stand-in on :${PORT}, ask delay ${ASK_DELAY_MS}ms`));
