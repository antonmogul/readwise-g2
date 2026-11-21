/**
 * Which app this build is.
 *
 * One codebase ships two Even Hub apps. The default build is the public one:
 * no board, no voice Ask, no microphone; its AI is the reader's own Claude key.
 * A personal build adds a "Brain board" — a backend of your own that does
 * speech-to-text and library search — by setting `VITE_BOARD_BASE` at BUILD
 * time (`npm run pack:private` reads it from the untracked `.env.private`).
 * With no URL configured, the bundler drops the board code entirely.
 */
export const BOARD_BASE: string =
  (import.meta.env?.VITE_BOARD_BASE as string | undefined) ?? '';

export const PUBLIC_BUILD: boolean = BOARD_BASE === '';

/** Whether this build talks to a Brain board at all. */
export const boardEnabled = (): boolean => !PUBLIC_BUILD;

/**
 * The app's name where the app names itself. Both apps are "Readwise" — the
 * brand and the service it reads (Anton's call, 2026-11-21); the listing and the
 * showcase say it is an independent app. One constant, so a rename is one edit
 * here plus `name` in the manifest.
 */
export const APP_NAME = 'Readwise';
