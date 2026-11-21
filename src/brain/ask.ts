/**
 * One way to ask a model, whichever model it is.
 *
 * With the reader's own Claude key, the app calls Anthropic directly
 * (`claude.ts`). Without one, it asks the Brain board — Anton's machine, in
 * text mode — as it always has. Summaries and Feed triage do not care which;
 * they hand over instructions and material, and get text back or a throw.
 */

import { askClaude, explainClaudeError, type ClaudeSettings, type Prompt } from './claude';
import { boardBase, ASK_PATH } from './summarise';
import { boardEnabled } from '../build';

export type AskOptions = {
  /** The reader's Claude settings; null or absent means use the board. */
  claude?: ClaudeSettings | null;
  /** Board base URL override (tests, the stand-in). */
  base?: string;
  fetchImpl?: typeof fetch;
  /** Deadline for the board. Claude gets `claudeTimeoutMs`, or the same. */
  timeoutMs: number;
  claudeTimeoutMs?: number;
};

/** Which model answers, for labels and for what a failure is called. */
export const provider = (o: Pick<AskOptions, 'claude'>): 'claude' | 'brain' =>
  o.claude?.apiKey ? 'claude' : 'brain';

/** A failure, worded for the reader. Never the raw error — that can carry a URL. */
export class AskError extends Error {}

export async function askModel(prompt: Prompt, o: AskOptions): Promise<string> {
  if (o.claude?.apiKey) {
    try {
      return await askClaude(prompt, o.claude, {
        fetchImpl: o.fetchImpl, timeoutMs: o.claudeTimeoutMs ?? o.timeoutMs,
      });
    } catch (e) {
      throw new AskError(explainClaudeError(e));
    }
  }
  // No key and no board (the public build): there is nobody to ask. Without
  // this the board URL is '' and the request went to the app's own host —
  // Feed headlines sent somewhere the privacy policy says nothing goes.
  if (!boardEnabled()) throw new AskError('Add a Claude key in Settings for AI features');
  const f = o.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs);
  try {
    const res = await f(`${o.base ?? boardBase()}${ASK_PATH}`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json' },
      // The board takes one string. Instructions first, material after the
      // rule — the same shape the prompts had before they were split.
      body: JSON.stringify({ question: `${prompt.system}\n\n---\n${prompt.user}` }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { reply?: string };
    const reply = body.reply?.trim();
    if (!reply) throw new Error('empty reply');
    return reply;
  } catch {
    throw new AskError('Brain unavailable · try again later');
  } finally {
    clearTimeout(timer);
  }
}
