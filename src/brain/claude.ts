/**
 * Claude, called straight from the app with the reader's own API key.
 *
 * WHY DIRECT. A Brain board is someone's own machine on their tailnet; nobody
 * else can reach it, and a public app cannot ship a key (an .ehpk unzips). So for
 * anyone else the AI is their own Anthropic account, called from the webview:
 * `api.anthropic.com` answers a browser preflight with `allow-origin: *` and
 * allows `authorization` (SDK 1.x sends the key as a bearer token) and the
 * direct-browser-access header that `dangerouslyAllowBrowser` adds (checked
 * 2026-11-20). The key never leaves the
 * device except to Anthropic. No tools are offered, so the article text — which
 * strangers wrote — can only shape the reply, never act.
 */

import type AnthropicClient from '@anthropic-ai/sdk';

/**
 * The SDK, loaded on first use. It is ~380 KB — more than the rest of the app —
 * and only readers who added a key ever need it, so it is a separate chunk
 * rather than part of the bundle every launch parses.
 */
let sdk: typeof AnthropicClient | null = null;
const loadSdk = async (): Promise<typeof AnthropicClient> =>
  (sdk ??= (await import('@anthropic-ai/sdk')).default);

/** What the reader can choose in Settings. Opus first: it is the default. */
export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — best' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — balanced' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — fastest, cheapest' },
] as const;

export type ClaudeModel = (typeof CLAUDE_MODELS)[number]['id'];
export const DEFAULT_MODEL: ClaudeModel = 'claude-opus-5-5';

export type ClaudeSettings = { apiKey: string; model: ClaudeModel };

export const isClaudeModel = (m: unknown): m is ClaudeModel =>
  CLAUDE_MODELS.some((x) => x.id === m);

/** Instructions and the material they apply to, kept apart. */
export type Prompt = { system: string; user: string };

/**
 * Settings as stored: one JSON string. Anything unreadable is "not configured"
 * rather than an error — a bad value must not stop the library loading.
 */
export function parseSettings(raw: string): ClaudeSettings | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { apiKey?: unknown; model?: unknown };
    const apiKey = typeof v.apiKey === 'string' ? v.apiKey.trim() : '';
    if (!apiKey) return null;
    return { apiKey, model: isClaudeModel(v.model) ? v.model : DEFAULT_MODEL };
  } catch {
    return null;
  }
}

export const serialiseSettings = (s: ClaudeSettings): string => JSON.stringify(s);

/**
 * Ask Claude once. Throws on any failure; callers own the fallback.
 *
 * Opus and Sonnet carry the server-side refusal fallback ('default' routes by
 * refusal category, so there is no model list to keep current). Haiku has no
 * server-side fallback; a refusal there is simply a failure.
 */
export async function askClaude(
  prompt: Prompt,
  settings: ClaudeSettings,
  opts: { fetchImpl?: typeof fetch; timeoutMs: number },
): Promise<string> {
  const Anthropic = await loadSdk();
  const client = new Anthropic({
    apiKey: settings.apiKey,
    dangerouslyAllowBrowser: true,
    timeout: opts.timeoutMs,
    // One retry: a 429 or a dropped connection on the glasses is common, but the
    // person is looking at a status line, and three attempts is a long wait.
    maxRetries: 1,
    // Dev only, read at BUILD time: the stand-in's /v1/messages, so the flow can
    // be driven and filmed without spending credit. pack.mjs refuses a bundle
    // that still points at it.
    ...(import.meta.env?.VITE_ANTHROPIC_BASE ? { baseURL: import.meta.env.VITE_ANTHROPIC_BASE as string } : {}),
    ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
  });
  const fallback = settings.model !== 'claude-haiku-5-5';
  const res = await client.beta.messages.create({
    model: settings.model,
    max_tokens: 16000,
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user }],
    ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
  });
  if (res.stop_reason === 'refusal') throw new Error('Claude declined this one');
  const text = res.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
  if (!text) throw new Error('Claude sent an empty reply');
  return text;
}

/**
 * What to tell the reader when a Claude call fails — short enough for a HUD
 * notice line, and pointing at the one thing they can fix.
 */
export function explainClaudeError(e: unknown): string {
  // No SDK loaded means the call never got as far as Anthropic.
  const Anthropic = sdk;
  if (!Anthropic) return 'Claude unavailable · try again later';
  if (e instanceof Anthropic.AuthenticationError) return 'Claude key rejected · check Settings';
  if (e instanceof Anthropic.PermissionDeniedError) return 'Claude key not allowed · check Settings';
  if (e instanceof Anthropic.RateLimitError) return 'Claude is busy · try again shortly';
  if (e instanceof Anthropic.APIError && e.status === 402) return 'Claude credit is used up';
  return 'Claude unavailable · try again later';
}
