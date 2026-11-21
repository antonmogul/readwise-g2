/**
 * How to get from the screen that is up to the one wanted: nothing, an
 * in-place upgrade of a few containers, or a rebuild of the page.
 *
 * `rebuildPageContainer` redraws everything and flickers on hardware;
 * `textContainerUpgrade` changes one container's `content` and `textColor`
 * in place, flicker-free — and can change NOTHING else (SDK 0.0.16 typings:
 * containerID, containerName, contentOffset, contentLength, content,
 * textColor). So an upgrade is allowed only when the two screens have the
 * same containers in the same places with the same borders, padding and
 * capture, and the same menu — a focus move, a notice landing, a summary
 * arriving. Anything else rebuilds, as before. Pure, so the decision is
 * tested rather than discovered on-device.
 */

import type { Screen, TextSpec } from './layout';

export type ScreenDiff =
  | { kind: 'same' }
  | { kind: 'upgrade'; changed: TextSpec[] }
  | { kind: 'rebuild' };

/** Everything an upgrade cannot change. */
const GEOMETRY: ReadonlyArray<keyof TextSpec> = [
  'kind', 'xPosition', 'yPosition', 'width', 'height', 'containerID', 'containerName',
  'borderWidth', 'borderColor', 'borderRadius', 'paddingLength', 'isEventCapture',
];

const sameMenu = (a: Screen['menuItems'], b: Screen['menuItems']): boolean =>
  JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

export function diffScreens(prev: Screen | null, next: Screen): ScreenDiff {
  if (!prev) return { kind: 'rebuild' };
  if (prev.containers.length !== next.containers.length) return { kind: 'rebuild' };
  // The menu is declared with the page; only a rebuild carries a new one.
  if (!sameMenu(prev.menuItems, next.menuItems)) return { kind: 'rebuild' };

  const changed: TextSpec[] = [];
  for (let i = 0; i < next.containers.length; i++) {
    const a = prev.containers[i];
    const b = next.containers[i];
    for (const key of GEOMETRY) {
      if (a[key] !== b[key]) return { kind: 'rebuild' };
    }
    if (a.content !== b.content || a.textColor !== b.textColor) changed.push(b);
  }
  return changed.length === 0 ? { kind: 'same' } : { kind: 'upgrade', changed };
}
