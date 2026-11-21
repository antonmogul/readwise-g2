/**
 * @vitest-environment happy-dom
 *
 * First run on the phone. Settings is the one place setup happens: with no
 * token the phone opens straight into it, and before storage has answered it
 * draws nothing rather than flash setup at someone who has a token saved.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, type PhoneState, type PhoneActions } from './render';
import { noFilter } from './views';

const state = (over: Partial<PhoneState> = {}): PhoneState => ({
  route: { name: 'library' }, filter: noFilter(), docs: [], viewDocs: [],
  stale: false, syncedAt: null, error: null, loading: false,
  article: null, articleLoading: false,
  tokenPresent: false, tokenChecked: true,
  claude: { saved: false, model: 'claude-opus-5-5' }, boardEnabled: false,
  ...over,
});

const actions = (): PhoneActions => ({
  go: vi.fn(), setFilter: vi.fn(), refresh: vi.fn(), archive: vi.fn(),
  summarise: vi.fn(), saveToken: vi.fn(), saveClaude: vi.fn(),
});

const draw = (s: PhoneState) => {
  const root = document.createElement('div');
  render(root, s, actions());
  return root;
};

describe('phone first run', () => {
  it('with no token, opens straight into Settings — no Back, no second setup card', () => {
    const root = draw(state());
    expect(root.textContent).toContain('Readwise access token');
    expect(root.textContent).toContain('Claude API key');
    expect(root.textContent).not.toContain('Connect your Reader library');
    expect([...root.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Back');
  });

  it('is blank until storage has answered, so a saved token never sees setup flash', () => {
    const root = draw(state({ tokenChecked: false }));
    expect(root.textContent).toBe('');
  });

  it('with a token, shows the library with Settings one tap away, and Back from Settings', () => {
    const lib = draw(state({ tokenPresent: true }));
    expect(lib.querySelector('[aria-label="Open settings"]')).not.toBeNull();
    expect(lib.textContent).not.toContain('Readwise access token');
    const settings = draw(state({ tokenPresent: true, route: { name: 'settings' } }));
    expect([...settings.querySelectorAll('button')].map((b) => b.textContent)).toContain('Back');
  });
});
