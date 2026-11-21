/**
 * Gesture decoding — the one piece of `main.ts` that can be tested without a
 * bridge, and the piece with the worst failure history.
 *
 * Two bugs have already shipped here:
 *   1. the listener was named `onEvent`, so NO gesture ever arrived;
 *   2. `sysEvent` was decoded as `t === 3 ? 'double' : 'press'`, so every
 *      lifecycle event (background, exit, IMU) synthesised a PRESS.
 *
 * Neither was catchable in the simulator — its injected input only ever sends
 * eventType 0..3, and it never emits lifecycle events at all. So this file is
 * the ONLY guard against the second one regressing. Treat it as load-bearing.
 */

import { describe, it, expect } from 'vitest';
import { OsEventTypeList } from '@evenrealities/even_hub_sdk';
import { gestureFrom, acceptHold, lifecycleFrom, HOLD_GAP_MS } from './main-gestures';

describe('gestureFrom — the five real gestures', () => {
  it('decodes a click on sysEvent as press', () => {
    expect(gestureFrom({ sysEvent: { eventType: OsEventTypeList.CLICK_EVENT } })).toBe('press');
  });

  it('decodes a double click on sysEvent', () => {
    expect(gestureFrom({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } })).toBe('double');
  });

  it('tolerates a sysEvent with no eventType as a plain tap', () => {
    // Some hosts omit eventType entirely on a simple click.
    expect(gestureFrom({ sysEvent: {} })).toBe('press');
  });

  it('decodes scrolls on the OTHER channel — textEvent, not sysEvent', () => {
    expect(gestureFrom({ textEvent: { eventType: OsEventTypeList.SCROLL_TOP_EVENT } })).toBe('up');
    expect(gestureFrom({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } })).toBe('down');
  });

  it('accepts a bare numeric textEvent', () => {
    // The `?? event.textEvent` fallback: some hosts send the value directly.
    expect(gestureFrom({ textEvent: 1 })).toBe('up');
    expect(gestureFrom({ textEvent: 2 })).toBe('down');
  });

  it('decodes a plain long press as hold, on either channel', () => {
    // Verified shape from simulator 0.9.5: { sysEvent: { eventType: 9 } }.
    expect(gestureFrom({ sysEvent: { eventType: OsEventTypeList.LONG_PRESS_EVENT } })).toBe('hold');
    // SDK 0.0.15+ keeps the source (right temple, ring, left temple) on it.
    expect(gestureFrom({ sysEvent: { eventType: OsEventTypeList.LONG_PRESS_EVENT, eventSource: 2 } })).toBe('hold');
    expect(gestureFrom({ textEvent: { eventType: OsEventTypeList.LONG_PRESS_EVENT } })).toBe('hold');
  });
});

describe('gestureFrom — a long press RELEASE is not a second hold', () => {
  // Hold archives and moves on. If the release decoded too, one gesture would
  // archive the open article AND the one it moved on to.
  it('is inert on sysEvent', () => {
    expect(gestureFrom({ sysEvent: { eventType: OsEventTypeList.LONG_PRESS_RELEASE_EVENT } })).toBeNull();
  });

  it('is inert on textEvent', () => {
    expect(gestureFrom({ textEvent: { eventType: OsEventTypeList.LONG_PRESS_RELEASE_EVENT } })).toBeNull();
  });
});

describe('acceptHold — one hold reported twice is one hold', () => {
  it('rejects a second hold inside the gap', () => {
    expect(acceptHold(10_000, 10_000 + HOLD_GAP_MS - 1)).toBe(false);
  });

  it('accepts a deliberate hold after the gap', () => {
    expect(acceptHold(10_000, 10_000 + HOLD_GAP_MS)).toBe(true);
  });

  it('accepts the first hold of the session', () => {
    expect(acceptHold(0, 5_000)).toBe(true);
  });
});

describe('gestureFrom — lifecycle events are NOT gestures', () => {
  /**
   * This is the regression guard. Each of these arrives on `sysEvent`, and each
   * one used to decode as a press.
   *
   * The concrete harm: sitting on the `confirm` screen with Yes focused, the
   * user glances away, the app backgrounds, FOREGROUND_EXIT_EVENT arrives — and
   * the synthesised press moves a card the user never confirmed. Cards are vault
   * markdown, so that is a write to disk from an event the user did not cause.
   */
  const lifecycle = [
    ['FOREGROUND_ENTER_EVENT', OsEventTypeList.FOREGROUND_ENTER_EVENT],
    ['FOREGROUND_EXIT_EVENT', OsEventTypeList.FOREGROUND_EXIT_EVENT],
    ['ABNORMAL_EXIT_EVENT', OsEventTypeList.ABNORMAL_EXIT_EVENT],
    ['SYSTEM_EXIT_EVENT', OsEventTypeList.SYSTEM_EXIT_EVENT],
    ['IMU_DATA_REPORT', OsEventTypeList.IMU_DATA_REPORT],
  ] as const;

  for (const [name, type] of lifecycle) {
    it(`${name} (${type}) produces no gesture`, () => {
      expect(gestureFrom({ sysEvent: { eventType: type } })).toBeNull();
    });
  }

  it('an IMU report carrying data is still not a gesture', () => {
    const imu = { sysEvent: { eventType: OsEventTypeList.IMU_DATA_REPORT, imuData: { x: 1, y: 2, z: 3 } } };
    expect(gestureFrom(imu)).toBeNull();
  });

  it('a system exit carrying a reason code is still not a gesture', () => {
    const exit = { sysEvent: { eventType: OsEventTypeList.SYSTEM_EXIT_EVENT, systemExitReasonCode: 2 } };
    expect(gestureFrom(exit)).toBeNull();
  });

  it('an UNKNOWN future eventType is inert rather than a press', () => {
    // The allowlist's whole point: the SDK enum has grown before and may again.
    expect(gestureFrom({ sysEvent: { eventType: 99 } })).toBeNull();
  });
});

describe('gestureFrom — junk', () => {
  it('ignores empty, null and unrelated events', () => {
    expect(gestureFrom(null)).toBeNull();
    expect(gestureFrom(undefined)).toBeNull();
    expect(gestureFrom({})).toBeNull();
    expect(gestureFrom({ listEvent: { eventType: 0 } })).toBeNull();
    expect(gestureFrom({ audioEvent: { audioPcm: new Uint8Array(4) } })).toBeNull();
  });

  it('ignores a textEvent carrying a click — wrong channel for a press', () => {
    // Only scrolls are meaningful on textEvent; a click here is not our press.
    expect(gestureFrom({ textEvent: { eventType: OsEventTypeList.CLICK_EVENT } })).toBeNull();
  });
});

describe('lifecycleFrom — what closes the microphone', () => {
  it('reads the contextual menu opening as an overlay', () => {
    expect(lifecycleFrom({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT } })).toBe('overlay');
  });

  it('reads both exits as exits', () => {
    expect(lifecycleFrom({ sysEvent: { eventType: OsEventTypeList.ABNORMAL_EXIT_EVENT } })).toBe('exit');
    expect(lifecycleFrom({ sysEvent: { eventType: OsEventTypeList.SYSTEM_EXIT_EVENT } })).toBe('exit');
  });

  it('ignores gestures, the menu closing, and junk', () => {
    expect(lifecycleFrom({ sysEvent: {} })).toBeNull();
    expect(lifecycleFrom({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } })).toBeNull();
    expect(lifecycleFrom({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT } })).toBeNull();
    expect(lifecycleFrom({ textEvent: { eventType: 1 } })).toBeNull();
    expect(lifecycleFrom(null)).toBeNull();
  });
});
