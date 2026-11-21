import { describe, it, expect, vi } from 'vitest';
import { askClaude, parseSettings, serialiseSettings, explainClaudeError, DEFAULT_MODEL } from './claude';
import { summarise } from './summarise';
import { triage } from './digest';
import type { Doc } from '../readwise/client';

/** A fake Anthropic: records each request, answers with `reply`. */
function anthropic(reply: { status?: number; text?: string; stop?: string; body?: unknown } = {}) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    void url; void init;
    const status = reply.status ?? 200;
    const body = reply.body ?? (status === 200
      ? {
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
        content: [{ type: 'text', text: reply.text ?? 'A gist.' }],
        stop_reason: reply.stop ?? 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }
      : { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
}

const call = (f: ReturnType<typeof anthropic>, i = 0) => {
  const [url, init] = f.mock.calls[i];
  const headers = new Headers(init?.headers);
  return { url: String(url), headers, body: JSON.parse(String(init?.body)) };
};

const opus = { apiKey: 'sk-ant-test', model: 'claude-opus-5-5' as const };
const p = { system: 'Do the thing.', user: 'Material.' };

describe('parseSettings', () => {
  it('round-trips', () => {
    expect(parseSettings(serialiseSettings(opus))).toEqual(opus);
  });
  it('is null without a key — nothing configured, not an error', () => {
    expect(parseSettings('')).toBeNull();
    expect(parseSettings('{"apiKey":"  "}')).toBeNull();
    expect(parseSettings('not json')).toBeNull();
  });
  it('falls back to the default model for an unknown one', () => {
    expect(parseSettings('{"apiKey":"k","model":"gpt-9"}')!.model).toBe(DEFAULT_MODEL);
  });
});

describe('askClaude', () => {
  // Verified 2026-11-20: api.anthropic.com allows browser origins only with the
  // direct-browser-access header, which `dangerouslyAllowBrowser` sends.
  it('calls Anthropic directly, as a browser, with the reader\'s key and model', async () => {
    const f = anthropic();
    await expect(askClaude(p, opus, { fetchImpl: f as unknown as typeof fetch, timeoutMs: 1000 }))
      .resolves.toBe('A gist.');
    const c = call(f);
    expect(c.url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages/);
    // SDK 1.x sends the key as a bearer token (not x-api-key); the CORS check
    // allows `authorization` from a browser origin.
    expect(c.headers.get('authorization')).toBe('Bearer sk-ant-test');
    expect(c.headers.get('anthropic-dangerous-direct-browser-access')).toBe('true');
    expect(c.body.model).toBe('claude-opus-5-5');
    // Instructions as the system prompt; the stranger-written text as the user turn.
    expect(c.body.system).toBe('Do the thing.');
    expect(c.body.messages).toEqual([{ role: 'user', content: 'Material.' }]);
    // No tools: the article can shape the reply, never act.
    expect(c.body.tools).toBeUndefined();
  });

  it('asks for the server-side refusal fallback on Opus and Sonnet, not Haiku', async () => {
    const f = anthropic();
    await askClaude(p, opus, { fetchImpl: f as unknown as typeof fetch, timeoutMs: 1000 });
    expect(call(f).body.fallbacks).toBe('default');
    expect(call(f).headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    const h = anthropic();
    await askClaude(p, { ...opus, model: 'claude-haiku-5-5' }, { fetchImpl: h as unknown as typeof fetch, timeoutMs: 1000 });
    expect(call(h).body.fallbacks).toBeUndefined();
  });

  it('treats a refusal as a failure, not as the summary', async () => {
    const f = anthropic({ stop: 'refusal', text: '' });
    await expect(askClaude(p, opus, { fetchImpl: f as unknown as typeof fetch, timeoutMs: 1000 })).rejects.toThrow();
  });

  it('says a rejected key is the key', async () => {
    const f = anthropic({ status: 401 });
    const e = await askClaude(p, opus, { fetchImpl: f as unknown as typeof fetch, timeoutMs: 1000 }).catch((x) => x);
    expect(explainClaudeError(e)).toBe('Claude key rejected · check Settings');
    // A 401 is not retried.
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('summaries and triage with a Claude key', () => {
  it('summarise goes to Anthropic, never to the board', async () => {
    const f = anthropic({ text: '**Bold** gist.' });
    const s = await summarise('T', 'A', 'Body text.', { claude: opus, fetchImpl: f as unknown as typeof fetch });
    expect(s).toEqual({ text: 'Bold gist.', fromBrain: true });
    expect(f.mock.calls.every(([u]) => String(u).startsWith('https://api.anthropic.com/'))).toBe(true);
    expect(call(f).body.messages[0].content).toContain('Title: T');
  });

  it('a failed Claude summary falls back to the extract and says why', async () => {
    const f = anthropic({ status: 401 });
    const s = await summarise('T', null, 'Body text.', { claude: opus, fetchImpl: f as unknown as typeof fetch });
    expect(s.fromBrain).toBe(false);
    expect(s.error).toBe('Claude key rejected · check Settings');
  });

  it('triage goes to Anthropic too', async () => {
    const doc = { id: 'd1', title: 'Headline', site_name: 'Wired' } as Doc;
    const f = anthropic({ text: '{"sections":[{"name":"Tech","note":"why","ids":["d1"]}]}' });
    const picks = await triage([doc], { claude: opus, fetchImpl: f as unknown as typeof fetch });
    expect(picks).toEqual([{ name: 'Tech', note: 'why', ids: ['d1'] }]);
    expect(call(f).body.messages[0].content).toContain('d1\tWired\tHeadline');
  });
});
