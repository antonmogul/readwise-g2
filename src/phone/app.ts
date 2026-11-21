/**
 * Phone app controller.
 *
 * Owns state and effects; `render.ts` owns pixels; `views.ts` owns decisions.
 * Mounts into the Even Hub webview — the same page also drives the glasses
 * through the SDK bridge in `main.ts`.
 */

import { render, type PhoneState, type PhoneActions } from './render';
import { noFilter, libraryVM, type PhoneRoute, type Filter } from './views';
import { localStorageOnly, type AppStorage } from '../readwise/storage';
import { readToken, saveToken, hydrate, tokenReady } from '../readwise/token';
import { readClaude, saveClaude, hydrateClaude } from '../brain/settings';
import { DEFAULT_MODEL, type ClaudeSettings, type ClaudeModel } from '../brain/claude';
import { boardEnabled } from '../brain/summarise';
import { select, nextAfter } from '../readwise/views';
import {
  loadLibraryState, loadArticleText, summariseArticle, archiveArticle, syncedAt, type AppDeps,
} from '../app';

/**
 * The token lives in device storage, entered in Settings — never in the repo
 * and never in the packaged app. It is per-device by design: the .ehpk is a
 * file that can be shared, and a baked-in credential would travel with it.
 *
 * Storage itself lives in `readwise/token.ts`: it has to reach the HOST store
 * through the bridge to survive the app closing, and both shells need the same
 * value. Re-exported here because `main.ts` has always imported it from this
 * module.
 */
export { readToken } from '../readwise/token';

export type PhoneHandle = {
  /** Tear down. */
  unmount(): void;
  /**
   * Swap in host-backed storage once the bridge exists, and repaint.
   *
   * The phone mounts BEFORE the bridge — deliberately, since waiting would
   * leave it blank whenever the glasses are not connected — so it starts on
   * webview storage and is upgraded here rather than at construction.
   */
  useStorage(next: AppStorage): void;
};

export function mountPhone(root: HTMLElement): PhoneHandle {
  const state: PhoneState = {
    route: { name: 'library' },
    filter: noFilter(),
    docs: [],
    viewDocs: [],
    stale: false,
    syncedAt: null,
    error: null,
    loading: true,
    article: null,
    articleLoading: false,
    tokenPresent: Boolean(readToken()),
    claude: { saved: readClaude() !== null, model: readClaude()?.model ?? DEFAULT_MODEL },
    boardEnabled: boardEnabled(),
  };

  let fetchedAt = 0;
  // Webview-only until `useStorage` upgrades it — see `PhoneHandle`.
  let storage: AppStorage = localStorageOnly();
  const deps = (): AppDeps => ({
    readwise: { token: readToken() },
    claude: readClaude(),
    kv: storage.kv,
    now: () => Date.now(),
  });

  const paint = () => render(root, state, actions);

  /**
   * Draw the view slice.
   *
   * Called ONLY when the library or the chosen view changes — never on a
   * keystroke. `select()` for Surprise runs a shuffle, so re-running it per
   * filter change rescrambled the results underneath the user as they typed
   * in the search box.
   */
  function reselect(): void {
    state.viewDocs = state.filter.view === 'all'
      ? []
      : select(state.filter.view, state.docs, new Date());
  }

  /** Drop documents that have left the library, preserving the drawn order. */
  function pruneView(): void {
    const ids = new Set(state.docs.map((d) => d.id));
    state.viewDocs = state.viewDocs.filter((d) => ids.has(d.id));
  }

  async function refresh(): Promise<void> {
    if (!readToken()) {
      // Durable storage may not have answered yet. Saying "add your token"
      // before it has would flash a setup prompt at a user who already has one
      // saved — the exact complaint this storage change exists to fix — so
      // stay in the loading state and let hydration re-run this.
      if (!tokenReady()) {
        state.loading = true;
        paint();
        return;
      }
      // No token is not an error to retry — it is a setup step. Say so, and
      // let the user reach Settings rather than spinning on a 401.
      state.loading = false;
      state.error = 'Add your Readwise token in Settings.';
      paint();
      return;
    }
    state.loading = true;
    paint();

    const s = await loadLibraryState(deps());
    state.docs = s.docs;
    state.stale = s.stale;
    state.error = s.error;
    fetchedAt = s.fetchedAt;
    state.syncedAt = syncedAt(s.fetchedAt);
    state.loading = false;
    reselect();
    paint();
  }

  const actions: PhoneActions = {
    go(r: PhoneRoute) {
      state.route = r;
      if (r.name === 'article') {
        const doc = state.docs.find((d) => d.id === r.id);
        state.article = null;
        state.articleLoading = true;
        paint();
        if (!doc) { state.articleLoading = false; paint(); return; }
        // Ignore a resolution the user has already navigated away from —
        // otherwise a slow fetch paints over the screen they moved to.
        const current = () => state.route.name === 'article' && state.route.id === r.id;
        void (async () => {
          // Text, and a summary only if one is cached. Asking the Brain is a
          // Claude session on the mini, so it waits for the Summarise button
          // rather than running on every article opened (2026-11-19).
          const t = await loadArticleText(deps(), doc);
          if (!current()) return;
          if (t.error) state.error = t.error;
          state.article = { doc, text: t.text, summary: t.cachedSummary, summaryState: 'idle' };
          state.articleLoading = false;
          paint();
        })();
        return;
      }
      paint();
    },

    setFilter(p: Partial<Filter>) {
      const viewChanged = p.view !== undefined && p.view !== state.filter.view;
      state.filter = { ...state.filter, ...p };
      // Only a change of VIEW redraws the slice. Typing in the search box
      // filters the drawn list; it must not redraw (and reshuffle) it.
      if (viewChanged) reselect();
      paint();
    },

    refresh() { void refresh(); },

    summarise(id: string) {
      const a = state.article;
      // One ask at a time, and never for a summary already on the page.
      if (!a || a.doc.id !== id || a.summary || a.summaryState === 'asking' || !a.text) return;
      state.article = { ...a, summaryState: 'asking' };
      paint();
      void summariseArticle(deps(), a.doc, a.text).then((s) => {
        // The user may have moved on; the summary is cached for next time anyway.
        if (state.article?.doc.id !== id) return;
        state.article = s.fromBrain
          ? { ...state.article, summary: s.text, summaryState: 'idle' }
          : { ...state.article, summaryState: 'failed', summaryError: s.error };
        paint();
      });
    },

    archive(id: string) {
      const current = { docs: state.docs, fetchedAt, stale: state.stale, error: state.error };
      // Next is read from the list as the user last saw it, before the prune —
      // the same "archive and move on" the glasses do on a hold.
      const shown = libraryVM(state.docs, state.viewDocs, state.filter,
        { stale: state.stale, syncedAt: state.syncedAt }).docs;
      const next = nextAfter(shown, id);
      void archiveArticle(deps(), current, id).then((r) => {
        if (!r.archived) {
          if (r.error) state.error = r.error;
          // The remote write did not commit, so keep the article open and
          // available for an explicit retry instead of pretending it moved.
          paint();
          return;
        }
        state.docs = r.state.docs;
        // Only REPLACE the error when this write produced one. Assigning
        // r.error unconditionally cleared a pre-existing offline or token
        // error that is still true, and the banner would vanish on a
        // successful archive while the app was still offline.
        // Prune, do not redraw: re-selecting would reshuffle a Surprise view
        // as a side effect of archiving one item.
        pruneView();
        // Archiving from the article screen means leaving it — the article is
        // no longer in the library the back button returns to. Straight on to
        // the next one when there is one; the list says when there is not.
        if (next) {
          actions.go({ name: 'article', id: next.doc.id });
          return;
        }
        state.route = { name: 'library' };
        state.article = null;
        paint();
      });
    },

    saveClaude(apiKey: string | null, model: ClaudeModel) {
      // '' means "keep the saved key, change the model".
      const key = apiKey === '' ? readClaude()?.apiKey ?? '' : apiKey;
      const next: ClaudeSettings | null = key ? { apiKey: key, model } : null;
      // Synchronous first, like the token: `deps()` reads it on the next ask.
      void saveClaude(next);
      state.claude = { saved: next !== null, model };
      paint();
    },

    saveToken(token: string) {
      // The durable write crosses the bridge, so it is not awaited here: the
      // in-memory value is set synchronously by `saveToken`, which is what the
      // refresh below reads. Waiting would stall the repaint on a bridge hop.
      void saveToken(token);
      state.tokenPresent = true;
      state.route = { name: 'library' };
      void refresh();
    },
  };

  // Paint immediately — the phone must not wait on the bridge, which may never
  // arrive when the glasses are not connected. Hydration then supplies the
  // durable token and re-runs the load; `refresh` holds the loading state until
  // it settles, so the setup prompt cannot flash at a user who has a token.
  paint();
  void Promise.all([hydrate(), hydrateClaude()]).then(([token, claude]) => {
    state.tokenPresent = Boolean(token);
    state.claude = { saved: claude !== null, model: claude?.model ?? state.claude.model };
    return refresh();
  });

  // No polling. The rate limit is 20 requests/minute and a background poll
  // would spend it on data nobody is looking at.
  return {
    unmount: () => { root.innerHTML = ''; },
    useStorage: (next) => {
      storage = next;
      // The glasses shell hydrated the Claude settings from the host store
      // before handing this over; the phone mounted on the webview copy.
      const claude = readClaude();
      state.claude = { saved: claude !== null, model: claude?.model ?? state.claude.model };
      // Reload from the durable cache: the first paint ran off the webview
      // copy, which the host may have cleared since the last launch.
      void refresh();
    },
  };
}
