/**
 * Even Hub app design tokens.
 *
 * Verbatim from the official design system (`evenhub-app-ui` plugin,
 * distilled from "Even Realities – Software Design Guidelines", 2025).
 * These are NOT approximations — use the token, never a hand-picked grey.
 *
 * They also happen to match `Hermes Kanban.dc.html` exactly, which is a good
 * sign the design was drawn against the same system.
 */

export const TC = {
  /** On black, in brightness mode. */
  highlight: '#FFFFFF',
  /** Majority of primary body text. */
  first: '#232323',
  /** Secondary information. */
  second: '#7B7B7B',
  accent: '#232323',
  /** Warning messages. */
  red: '#FF453A',
  /** Device connection status. */
  green: '#4BB956',
} as const;

export const BC = {
  /** Dark filled buttons. */
  highlight: '#232323',
  /** Standard button background. */
  first: '#FFFFFF',
  /** Supporting layer — chat bubbles. */
  second: '#F6F6F6',
  /** Main page background. */
  third: '#EEEEEE',
  /** A deeper layer on top of third — toggle tracks. */
  fourth: '#E4E4E4',
  /** Ongoing action / warning toast. Yellow is ONLY for this. */
  accent: '#FEF991',
} as const;

export const SC = {
  /** Popup overlay. */
  scrim: 'rgba(0,0,0,0.5)',
  /** Text input fields. */
  input: 'rgba(35,35,35,0.08)',
} as const;

/** 12px screen margin · 16px card inset · 6px radius · 0/6/12/24 rhythm. */
export const SPACE = { screen: 12, card: 16, xs: 6, sm: 12, lg: 24 } as const;
export const RADIUS = 6;

/**
 * FK Grotesk Neue is the system font. It is not bundled here, so we state the
 * fallback explicitly rather than silently passing another font off as exact —
 * the design system asks for that directly.
 */
export const FONT =
  "'FK Grotesk Neue', -apple-system, 'SF Pro Text', system-ui, sans-serif";
