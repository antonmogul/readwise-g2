/**
 * Phone DOM layer.
 *
 * Renders the view models from `views.ts` and holds NO logic — every decision
 * lives in the view models, which are tested. This file only turns them into
 * elements.
 *
 * COLOURS ARE THE OFFICIAL TOKENS, never a hand-picked grey. A second palette
 * across two Even Hub apps is the stated failure mode, so `tokens.ts` is
 * copied verbatim from `brain-even-hub` rather than re-derived. The rules that
 * are easy to break and so are stated here:
 *
 *   - #FEF991 (Even yellow) is ACCENT ONLY — buttons and highlights. It is
 *     never a page background.
 *   - #3CFA44 (glasses green) is for the G2 display ONLY. It must not appear
 *     anywhere in this file.
 *   - FK Grotesk Neue type scale · 4/8px spacing grid · 16px card padding.
 */

import { TC, BC, SC, SPACE, RADIUS, FONT } from './tokens';
import type { Doc } from '../readwise/client';
import { CLAUDE_MODELS, type ClaudeModel } from '../brain/claude';
import { APP_NAME } from '../build';
import { VIEW_LABELS, type ViewKey } from '../readwise/views';
import * as V from './views';

const el = (tag: string, style: string, html = ''): HTMLElement => {
  const n = document.createElement(tag);
  n.setAttribute('style', style);
  if (html) n.innerHTML = html;
  return n;
};

/** Everything from Readwise is publisher-controlled and goes through this. */
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export type PhoneState = {
  route: V.PhoneRoute;
  filter: V.Filter;
  /** The whole library. */
  docs: Doc[];
  /** Documents pre-selected for the active view, when it is not 'all'. */
  viewDocs: Doc[];
  stale: boolean;
  syncedAt: string | null;
  error: string | null;
  loading: boolean;
  /** The open article, when the route is `article`. */
  article: PhoneArticle | null;
  articleLoading: boolean;
  tokenPresent: boolean;
  /** Durable storage has answered, so "no token" is known rather than not yet read. */
  tokenChecked: boolean;
  /** The reader's Claude settings as Settings shows them. The key itself never reaches the DOM. */
  claude: { saved: boolean; model: ClaudeModel };
  /** This build reaches the Brain board (off in a public build). */
  boardEnabled: boolean;
};

/** Who would write a summary now, or null when nothing can. */
export const aiName = (s: Pick<PhoneState, 'claude' | 'boardEnabled'>): 'Claude' | 'Brain' | null =>
  s.claude.saved ? 'Claude' : s.boardEnabled ? 'Brain' : null;

/**
 * The open article. `summary` is the Brain's, or null when none has been asked
 * for — opening an article does not ask (each summary is a Claude session on
 * the mini, 2026-11-19). The full text is on the page either way.
 */
export type PhoneArticle = {
  doc: Doc;
  text: string;
  summary: string | null;
  /** 'asking' while the model writes it; 'failed' when it could not, so a retry is offered. */
  summaryState: 'idle' | 'asking' | 'failed';
  /** Why the last ask failed, worded for the reader. */
  summaryError?: string;
};

export type PhoneActions = {
  go: (r: V.PhoneRoute) => void;
  setFilter: (p: Partial<V.Filter>) => void;
  refresh: () => void;
  archive: (id: string) => void;
  /** Ask the Brain for a summary of the open article. Only ever on a tap. */
  summarise: (id: string) => void;
  saveToken: (token: string) => void;
  /** Save the reader's Claude key and model; a null key removes it. */
  saveClaude: (apiKey: string | null, model: ClaudeModel) => void;
};

const HEADER_H = 60;

// ------------------------------------------------------------------ chrome

function header(title: string, actions: PhoneActions, back?: V.PhoneRoute): HTMLElement {
  const bar = el('div',
    `position:sticky;top:0;z-index:10;height:${HEADER_H}px;display:flex;` +
    `align-items:center;gap:${SPACE.sm}px;padding:0 ${SPACE.screen}px;` +
    `background:${BC.first};border-bottom:1px solid ${BC.fourth};`);

  if (back) {
    const b = el('button',
      `min-height:44px;border:0;background:transparent;font:500 15px ${FONT};` +
      `color:${TC.first};padding:0 4px 0 0;cursor:pointer;`, 'Back');
    b.setAttribute('aria-label', 'Go back');
    b.onclick = () => actions.go(back);
    bar.appendChild(b);
  }

  bar.appendChild(el('div',
    `flex:1;font:600 17px ${FONT};color:${TC.first};overflow:hidden;` +
    `text-overflow:ellipsis;white-space:nowrap;`, esc(title)));
  return bar;
}

/**
 * The stale banner. Uses the accent token, which is what it is FOR —
 * "ongoing action / warning toast" — rather than red, because offline with a
 * cached library is a degraded state, not an error.
 */
const staleBanner = (note: string): HTMLElement =>
  el('div',
    `margin:${SPACE.sm}px ${SPACE.screen}px;padding:10px ${SPACE.card}px;` +
    `background:${BC.accent};border-radius:${RADIUS}px;` +
    `font:400 13px ${FONT};color:${TC.first};`, esc(note));

/**
 * An error, stated in words and in the red text token.
 *
 * The design system carries no "error card" surface, and inventing one with a
 * coloured side-rule would be a second visual language on top of a system that
 * already has an opinion. `TC.red` exists precisely for warning messages, so
 * the text carries the signal and the layer stays a plain `second` surface.
 */
const errorBanner = (msg: string): HTMLElement =>
  el('div',
    `margin:${SPACE.sm}px ${SPACE.screen}px;padding:10px ${SPACE.card}px;` +
    `background:${BC.second};border-radius:${RADIUS}px;` +
    `font:400 13px ${FONT};color:${TC.red};`, esc(msg));

const emptyState = (msg: string): HTMLElement =>
  el('div',
    `padding:48px ${SPACE.screen}px;text-align:center;` +
    `font:400 15px ${FONT};color:${TC.second};`, esc(msg));

// -------------------------------------------------------------------- rows

function articleRow(d: Doc, actions: PhoneActions, now: Date): HTMLElement {
  const card = el('div',
    `padding:${SPACE.card}px;background:${BC.first};border-radius:${RADIUS}px;` +
    `margin-bottom:8px;cursor:pointer;`);

  card.appendChild(el('div',
    `font:500 15px ${FONT};color:${TC.first};line-height:1.35;margin-bottom:6px;`,
    esc(d.title)));

  const meta = [d.site_name, V.readingTime(d), V.savedLabel(d, now)]
    .filter(Boolean).join(' · ');
  card.appendChild(el('div',
    `font:400 13px ${FONT};color:${TC.second};`, esc(meta)));

  // Progress bar only when there IS progress — a 0% bar on every unread row is
  // visual noise that says nothing.
  const pct = V.progressPct(d);
  if (pct > 0) {
    const track = el('div',
      `margin-top:10px;height:3px;background:${BC.fourth};border-radius:2px;overflow:hidden;`);
    track.appendChild(el('div',
      `width:${pct}%;height:100%;background:${TC.first};`));
    card.appendChild(track);
  }

  card.onclick = () => actions.go({ name: 'article', id: d.id });
  return card;
}

function chip(label: string, active: boolean, onClick: () => void): HTMLElement {
  const c = el('button',
    `flex:0 0 auto;border:0;cursor:pointer;padding:7px 12px;border-radius:999px;` +
    `font:500 13px ${FONT};white-space:nowrap;` +
    (active
      ? `background:${BC.highlight};color:${TC.highlight};`
      : `background:${BC.second};color:${TC.first};`),
    esc(label));
  c.onclick = onClick;
  return c;
}

function filterBar(vm: V.LibraryVM, state: PhoneState, actions: PhoneActions): HTMLElement {
  const wrap = el('div', `padding:0 ${SPACE.screen}px ${SPACE.sm}px;`);

  const search = document.createElement('input');
  search.setAttribute('placeholder', 'Search your library');
  search.setAttribute('value', state.filter.query);
  search.setAttribute('style',
    `width:100%;box-sizing:border-box;border:0;border-radius:${RADIUS}px;` +
    `padding:11px ${SPACE.sm}px;background:${SC.input};` +
    `font:400 15px ${FONT};color:${TC.first};margin-bottom:${SPACE.sm}px;`);
  // `input`, not `change`: filtering as you type is the whole point of a
  // search box over a thousand items.
  search.oninput = () => actions.setFilter({ query: search.value });
  wrap.appendChild(search);

  const row = el('div',
    `display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;` +
    `-webkit-overflow-scrolling:touch;`);

  const views: (ViewKey | 'all')[] = ['all', 'recent', 'today', 'halfread', 'surprise'];
  for (const v of views) {
    row.appendChild(chip(
      v === 'all' ? 'All' : VIEW_LABELS[v],
      state.filter.view === v,
      () => actions.setFilter({ view: v }),
    ));
  }
  // Top publications only. A chip per publication across a thousand documents
  // is a scroll bar, not a filter.
  for (const s of vm.sites.slice(0, 8)) {
    row.appendChild(chip(
      `${s.name} ${s.count}`,
      state.filter.site === s.name,
      () => actions.setFilter({ site: state.filter.site === s.name ? null : s.name }),
    ));
  }
  wrap.appendChild(row);
  return wrap;
}

// ------------------------------------------------------------------ screens

function library(state: PhoneState, actions: PhoneActions): HTMLElement {
  const now = new Date();
  const vm = V.libraryVM(state.docs, state.viewDocs, state.filter,
    { stale: state.stale, syncedAt: state.syncedAt });

  const page = el('div', '');
  page.appendChild(header(APP_NAME, actions));

  if (vm.staleNote) page.appendChild(staleBanner(vm.staleNote));
  if (state.error && !vm.staleNote) page.appendChild(errorBanner(state.error));

  page.appendChild(filterBar(vm, state, actions));

  const body = el('div', `padding:0 ${SPACE.screen}px ${SPACE.lg}px;`);
  if (state.loading && state.docs.length === 0) {
    body.appendChild(emptyState('Loading your library…'));
  } else if (vm.empty) {
    body.appendChild(emptyState(vm.empty));
  } else {
    body.appendChild(el('div',
      `font:400 13px ${FONT};color:${TC.second};margin-bottom:8px;`,
      `${vm.docs.length} of ${vm.total}`));
    for (const d of vm.docs) body.appendChild(articleRow(d, actions, now));
  }
  page.appendChild(body);
  return page;
}

function article(state: PhoneState, actions: PhoneActions): HTMLElement {
  const page = el('div', '');
  const a = state.article;

  if (!a) {
    page.appendChild(header('Article', actions, { name: 'library' }));
    page.appendChild(emptyState(state.articleLoading ? 'Loading…' : 'Article not found.'));
    return page;
  }

  page.appendChild(header(a.doc.title, actions, { name: 'library' }));

  const body = el('div', `padding:${SPACE.sm}px ${SPACE.screen}px ${SPACE.lg}px;`);

  body.appendChild(el('div',
    `font:600 22px ${FONT};color:${TC.first};line-height:1.25;margin-bottom:8px;`,
    esc(a.doc.title)));

  const meta = [a.doc.author, a.doc.site_name, V.readingTime(a.doc)]
    .filter(Boolean).join(' · ');
  body.appendChild(el('div',
    `font:400 13px ${FONT};color:${TC.second};margin-bottom:${SPACE.card}px;`,
    esc(meta)));

  // The summary card: the Brain's summary when there is one, otherwise the way
  // to ask for it. Never filled unasked — and never with an extract: the full
  // text is right below, so a stand-in here would only repeat its opening.
  const sum = el('div',
    `padding:${SPACE.card}px;background:${BC.second};border-radius:${RADIUS}px;` +
    `margin-bottom:${SPACE.card}px;`);
  sum.appendChild(el('div',
    `font:600 11px ${FONT};color:${TC.second};letter-spacing:0.06em;` +
    `text-transform:uppercase;margin-bottom:8px;`,
    'AI summary'));
  const ai = aiName(state);
  if (a.summary) {
    // Paragraph by paragraph. The Brain writes the argument and then the
    // conclusion; one run-on block hid the turn between them.
    a.summary.split(/\n+/).filter((p) => p.trim()).forEach((para, i) => {
      sum.appendChild(el('p',
        `margin:${i ? 8 : 0}px 0 0;font:400 15px ${FONT};color:${TC.first};line-height:1.5;`,
        esc(para)));
    });
    body.appendChild(sum);
  } else if (a.text && ai) {
    if (a.summaryState === 'failed') {
      sum.appendChild(el('p', `margin:0 0 8px;font:400 15px ${FONT};color:${TC.second};`,
        esc(a.summaryError ?? 'The summary could not be written.')));
    }
    const asking = a.summaryState === 'asking';
    const ask = el('button',
      `width:100%;border:0;cursor:pointer;padding:12px;border-radius:${RADIUS}px;` +
      `background:${BC.accent};font:500 15px ${FONT};color:${TC.first};`,
      asking ? 'Summarising…' : a.summaryState === 'failed' ? 'Try again' : `Summarise with ${ai}`);
    if (asking) ask.setAttribute('disabled', '');
    else ask.onclick = () => actions.summarise(a.doc.id);
    sum.appendChild(ask);
    body.appendChild(sum);
  }

  const actionsRow = el('div', `display:flex;gap:8px;margin-bottom:${SPACE.lg}px;`);
  const archiveBtn = el('button',
    `flex:1;border:0;cursor:pointer;padding:12px;border-radius:${RADIUS}px;` +
    `background:${BC.accent};font:500 15px ${FONT};color:${TC.first};`,
    'Archive');
  archiveBtn.onclick = () => actions.archive(a.doc.id);
  actionsRow.appendChild(archiveBtn);

  const openBtn = el('a',
    `flex:1;text-align:center;text-decoration:none;padding:12px;` +
    `border-radius:${RADIUS}px;background:${BC.second};` +
    `font:500 15px ${FONT};color:${TC.first};`, 'Open original');
  openBtn.setAttribute('href', a.doc.url);
  openBtn.setAttribute('target', '_blank');
  openBtn.setAttribute('rel', 'noreferrer noopener');
  actionsRow.appendChild(openBtn);
  body.appendChild(actionsRow);

  // Full text. This is where reading belongs by default — the glasses can do
  // it, but the phone is better at it and the app should not pretend otherwise.
  if (a.text) {
    const prose = el('div',
      `font:400 17px ${FONT};color:${TC.first};line-height:1.6;`);
    for (const para of a.text.split('\n').filter((p) => p.trim())) {
      prose.appendChild(el('p', `margin:0 0 ${SPACE.card}px;`, esc(para)));
    }
    body.appendChild(prose);
  } else if (!state.articleLoading) {
    body.appendChild(emptyState('No readable text for this article.'));
  }

  page.appendChild(body);
  return page;
}

/**
 * The reader's own Claude key and model. Optional: without it the app reads,
 * previews and archives; with it, summaries and Feed sorting are written by
 * Claude on the reader's Anthropic account, called straight from this device.
 */
function claudeSettings(state: PhoneState, actions: PhoneActions): HTMLElement {
  const box = el('section', `margin-top:${SPACE.lg}px;`);
  box.setAttribute('aria-label', 'Claude');
  const label = el('label',
    `display:block;font:400 15px ${FONT};color:${TC.first};margin-bottom:${SPACE.xs}px;`,
    'Claude API key (optional)');
  label.setAttribute('for', 'claude-key');
  box.appendChild(label);
  box.appendChild(el('div',
    `font:400 13px ${FONT};color:${TC.second};margin-bottom:${SPACE.sm}px;`,
    'Adds AI summaries and Feed sorting. Create a key at console.anthropic.com. ' +
    'Stored on this device only and sent only to Anthropic; usage is billed to your Anthropic account.'));

  const field = `width:100%;box-sizing:border-box;border:0;border-radius:${RADIUS}px;` +
    `padding:11px ${SPACE.sm}px;background:${SC.input};` +
    `font:400 15px ${FONT};color:${TC.first};margin-bottom:${SPACE.sm}px;`;
  const key = document.createElement('input');
  key.id = 'claude-key';
  key.setAttribute('type', 'password');
  key.setAttribute('autocomplete', 'off');
  key.setAttribute('placeholder', state.claude.saved ? '••••••••  (saved)' : 'sk-ant-…');
  key.setAttribute('style', field);
  box.appendChild(key);

  const modelLabel = el('label',
    `display:block;font:400 15px ${FONT};color:${TC.first};margin-bottom:${SPACE.xs}px;`, 'Model');
  modelLabel.setAttribute('for', 'claude-model');
  box.appendChild(modelLabel);
  const model = document.createElement('select');
  model.id = 'claude-model';
  model.setAttribute('style', field);
  for (const m of CLAUDE_MODELS) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.label;
    if (m.id === state.claude.model) o.selected = true;
    model.appendChild(o);
  }
  box.appendChild(model);

  const row = el('div', `display:flex;gap:8px;`);
  const save = el('button',
    `border:0;cursor:pointer;padding:12px ${SPACE.lg}px;border-radius:${RADIUS}px;` +
    `background:${BC.highlight};color:${TC.highlight};font:500 15px ${FONT};`, 'Save');
  // A blank key with a saved one keeps the saved key: only the model changes.
  save.onclick = () => {
    const k = key.value.trim();
    if (k || state.claude.saved) actions.saveClaude(k || '', model.value as ClaudeModel);
  };
  row.appendChild(save);
  if (state.claude.saved) {
    const remove = el('button',
      `border:0;cursor:pointer;padding:12px ${SPACE.lg}px;border-radius:${RADIUS}px;` +
      `background:${BC.second};color:${TC.first};font:500 15px ${FONT};`, 'Remove key');
    remove.onclick = () => actions.saveClaude(null, model.value as ClaudeModel);
    row.appendChild(remove);
  }
  box.appendChild(row);
  return box;
}

function settings(state: PhoneState, actions: PhoneActions): HTMLElement {
  const page = el('div', '');
  // No Back on first run: there is no library to go back to until a token is saved.
  page.appendChild(header('Settings', actions, state.tokenPresent ? { name: 'library' } : undefined));

  const body = el('div', `padding:${SPACE.card}px ${SPACE.screen}px;`);
  const label = el('label',
    `display:block;font:400 15px ${FONT};color:${TC.first};margin-bottom:${SPACE.xs}px;`,
    'Readwise access token');
  label.setAttribute('for', 'readwise-token');
  body.appendChild(label);
  body.appendChild(el('div',
    `font:400 13px ${FONT};color:${TC.second};margin-bottom:${SPACE.sm}px;`,
    'From readwise.io/access_token. Stored on this device only.'));

  const input = document.createElement('input');
  input.id = 'readwise-token';
  input.setAttribute('type', 'password');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('placeholder', state.tokenPresent ? '••••••••  (saved)' : 'Paste your token');
  input.setAttribute('style',
    `width:100%;box-sizing:border-box;border:0;border-radius:${RADIUS}px;` +
    `padding:11px ${SPACE.sm}px;background:${SC.input};` +
    `font:400 15px ${FONT};color:${TC.first};margin-bottom:${SPACE.sm}px;`);
  body.appendChild(input);

  const save = el('button',
    `border:0;cursor:pointer;padding:12px ${SPACE.lg}px;border-radius:${RADIUS}px;` +
    `background:${BC.highlight};color:${TC.highlight};font:500 15px ${FONT};`,
    'Save');
  save.onclick = () => { if (input.value.trim()) actions.saveToken(input.value.trim()); };
  body.appendChild(save);

  body.appendChild(claudeSettings(state, actions));

  const guide = el('section',
    `margin-top:${SPACE.lg}px;padding:${SPACE.card}px;background:${BC.first};` +
    `border-radius:${RADIUS}px;color:${TC.first};`);
  guide.setAttribute('aria-label', 'Using Readwise on G2');
  const help = (title: string, copy: string) => {
    const section = el('div', `margin-bottom:${SPACE.lg}px;`);
    section.appendChild(el('h2',
      `font:400 17px ${FONT};letter-spacing:-0.17px;margin:0 0 ${SPACE.xs}px;`, title));
    section.appendChild(el('p',
      `font:300 15px/1.5 ${FONT};letter-spacing:-0.15px;margin:0;`, copy));
    guide.appendChild(section);
  };
  help('Open with Even AI',
    `With ${APP_NAME} installed and Even Realities App 2.4.0 or later, try asking Even AI to open ${APP_NAME}. ` +
    'You can also open it from the glasses app menu.');
  help('Pick up your reading',
    'Choose Continue on the glasses to find articles in progress. Reopening an article returns to your saved sheet. ' +
    'Positions stay on this device; they do not sync back to Readwise.');
  help('Summaries',
    'Articles open on a preview: the publisher\'s note or the opening. To get an AI summary, ' +
    'tap the temple, hold, and choose Summarise — or use the button on an article here. ' +
    'Summaries need a Claude key (above); each one is kept, so it is only paid for once.');
  if (state.boardEnabled) {
    help('Ask your library',
      'Choose Ask your library from the glasses menu to start listening. Spoken questions use ' +
      'your configured Brain service over Tailscale.');
  }
  help('Beta feedback', 'Contact the person who invited you to the beta. Include the article title, what happened and your Even Realities App version. Never share your access token.');
  const support = el('a',
    `display:inline-flex;align-items:center;min-height:44px;color:${TC.first};` +
    `font:400 15px ${FONT};text-decoration:underline;`, 'Readwise account help');
  support.setAttribute('href', 'https://readwise.io/faq');
  support.setAttribute('target', '_blank');
  support.setAttribute('rel', 'noopener noreferrer');
  guide.appendChild(support);
  body.appendChild(guide);

  page.appendChild(body);
  return page;
}

// ------------------------------------------------------------------- mount

export function render(root: HTMLElement, state: PhoneState, actions: PhoneActions): void {
  root.innerHTML = '';
  root.setAttribute('style',
    `margin:0;min-height:100vh;background:${BC.third};font-family:${FONT};` +
    `-webkit-font-smoothing:antialiased;`);

  // Settings is the one place setup happens. Without a token there is nothing
  // else to show, so the phone opens straight into it — the old "Connect your
  // Reader library" card was a second door to the same room (Anton, 2026-11-21).
  // Until durable storage answers, "no token" is not yet known: draw nothing
  // rather than flash setup at someone who has a token saved.
  if (!state.tokenPresent) {
    if (state.tokenChecked) root.appendChild(settings(state, actions));
    return;
  }

  const page =
    state.route.name === 'article' ? article(state, actions)
    : state.route.name === 'settings' ? settings(state, actions)
    : library(state, actions);

  root.appendChild(page);

  // A settings affordance must exist on the library screen, or a rejected
  // token leaves the user with no way to fix it.
  if (state.route.name === 'library') {
    const gear = el('button',
      `position:fixed;right:${SPACE.screen}px;top:8px;z-index:11;min-height:44px;` +
      `border:0;background:transparent;cursor:pointer;font:500 15px ${FONT};` +
      `color:${TC.first};padding:0 4px;`, 'Settings');
    gear.setAttribute('aria-label', 'Open settings');
    gear.onclick = () => actions.go({ name: 'settings' });
    root.appendChild(gear);
  }
}
