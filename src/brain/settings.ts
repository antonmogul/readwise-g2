/**
 * The reader's Claude settings: their own API key and chosen model.
 *
 * Durable and synchronous like the Readwise token (`readwise/token.ts`), for
 * the same reasons: they must survive the Even app closing, and both shells
 * read them on the render path. Stored as one JSON string under `rw.claude`.
 * Never built into a package: the only build-time fallback is a dev setting
 * that `pack.mjs` refuses to ship.
 */

import { durableString } from '../readwise/token';
import { parseSettings, serialiseSettings, type ClaudeSettings } from './claude';

export const CLAUDE_KEY = 'rw.claude';

/**
 * Dev only, read at BUILD time: preset settings for the simulator, which has no
 * phone to type a key into. Production builds have none — pack.mjs refuses a
 * bundle containing the stand-in's token.
 */
const devSettings = (): string =>
  (import.meta.env?.VITE_CLAUDE_SETTINGS as string | undefined) ?? '';

const value = durableString(CLAUDE_KEY, devSettings);

/** The saved settings, or null when no key has been added. */
export const readClaude = (): ClaudeSettings | null => parseSettings(value.read());

export const hydrateClaude = (): Promise<ClaudeSettings | null> =>
  value.hydrate().then(parseSettings);

/** Save, or clear with null. */
export const saveClaude = (s: ClaudeSettings | null): Promise<void> =>
  value.save(s ? serialiseSettings(s) : '');
