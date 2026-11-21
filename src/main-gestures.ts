/**
 * Gesture decoding, split out of `main.ts` so it can be tested.
 *
 * `main.ts` top-level-awaits the bridge, so importing it from a test would hang
 * forever. This is the only logic in that shell worth asserting, so it lives
 * here instead — see `main.gestures.test.ts`, which is the sole guard against
 * the lifecycle-event bug regressing.
 */

import { OsEventTypeList } from '@evenrealities/even_hub_sdk';
import type { Gesture } from './glass/nav';

/**
 * THE GOTCHA: clicks and double-clicks arrive on `sysEvent`; only scroll
 * gestures arrive on `textEvent`. Two channels, not one — handling only
 * textEvent silently loses every press.
 *
 * THE SECOND GOTCHA: `sysEvent` carries far more than clicks. `OsEventTypeList`
 * has NINE values — 4..8 are FOREGROUND_ENTER, FOREGROUND_EXIT, ABNORMAL_EXIT,
 * SYSTEM_EXIT and IMU_DATA_REPORT, and they all arrive on this same channel.
 * This used to read `t === 3 ? 'double' : 'press'`, so every one of those
 * lifecycle events synthesised a PRESS: backgrounding the app while sitting on
 * the confirm screen would move a card the user never confirmed — and cards are
 * vault markdown, so it wrote to disk.
 *
 * So this is an ALLOWLIST. Only the five real gestures produce a Gesture;
 * anything else is inert. The simulator cannot catch a regression here — its
 * injected input only ever sends 0..3 — so the unit test is the guard.
 *
 * THE THIRD: a plain long press (SDK 0.0.14+, LONG_PRESS_EVENT 9) is a gesture
 * — hold archives the open article — but its partner LONG_PRESS_RELEASE_EVENT
 * (10) is not. Decoding the release too would archive twice, and the second
 * archive would land on the article the first one moved on to.
 */
export function gestureFrom(event: any): Gesture | null {
  if (event?.sysEvent) {
    const t = event.sysEvent.eventType;
    // undefined is tolerated as a click: some hosts omit eventType on a plain tap.
    if (t === undefined || t === OsEventTypeList.CLICK_EVENT) return 'press';
    if (t === OsEventTypeList.DOUBLE_CLICK_EVENT) return 'double';
    if (t === OsEventTypeList.LONG_PRESS_EVENT) return 'hold';
    return null;
  }
  if (event?.textEvent) {
    const t = event.textEvent.eventType ?? event.textEvent;
    if (t === OsEventTypeList.SCROLL_TOP_EVENT) return 'up';
    if (t === OsEventTypeList.SCROLL_BOTTOM_EVENT) return 'down';
    // The docs put long presses on sysEvent only; the SDK README says they
    // still arrive on "the ordinary list/text/sys events". Accept both.
    if (t === OsEventTypeList.LONG_PRESS_EVENT) return 'hold';
  }
  return null;
}

/**
 * Holds closer together than this are one gesture seen twice.
 *
 * Because a hold is accepted on two channels, a host that reports it on both
 * would deliver two. Each hold archives and moves on, so the second would
 * archive the next article — one the user has not even seen. A deliberate
 * second hold takes longer than this: the next summary has to be read first.
 */
export const HOLD_GAP_MS = 1500;

export const acceptHold = (lastAcceptedAt: number, now: number): boolean =>
  now - lastAcceptedAt >= HOLD_GAP_MS;

/**
 * Lifecycle events that must close the microphone.
 *
 * Not gestures — `gestureFrom` rightly ignores them — but a mic left open is
 * worse than a missed press. FOREGROUND_ENTER (4) is the contextual menu
 * opening over the page (Even Hub docs, "Contextual Menu"): the user has moved
 * on from speaking. ABNORMAL_EXIT (6) and SYSTEM_EXIT (7) are the app going
 * away. brain-even-hub closes its mic on the same three.
 */
export function lifecycleFrom(event: any): 'overlay' | 'exit' | null {
  const t = event?.sysEvent?.eventType;
  if (t === OsEventTypeList.FOREGROUND_ENTER_EVENT) return 'overlay';
  if (t === OsEventTypeList.ABNORMAL_EXIT_EVENT || t === OsEventTypeList.SYSTEM_EXIT_EVENT) return 'exit';
  return null;
}
