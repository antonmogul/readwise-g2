/**
 * Waiting on a bridge call that may hang.
 *
 * A plain `Promise.race` against a timer rejects and MOVES ON while the
 * bridge call is still running — so the fallback that follows (a rebuild
 * after a slow upgrade) overlaps the call it was meant to replace, and
 * overlapping bridge calls can crash the connection (glasses-ui skill). So a
 * call that misses its soft deadline is not abandoned: the queue stays
 * blocked until it settles, and only then does the fallback run (review of
 * PR #1, on bdeceb2).
 *
 * Without a hard cap the wait is unbounded — and that is the right default
 * for a RENDER call: giving up and rebuilding while the call is still
 * pending let a late upgrade overwrite the rebuilt screen (review, round 6).
 * A queue that waits on a stuck bridge call is exactly what `serial()` has
 * always meant; nothing is gained by racing it. Pass `hardMs` only for a call
 * whose result nothing later depends on. Pure apart from timers, so the
 * ordering is tested.
 */

export type Settled<T> =
  | { kind: 'value'; value: T }
  | { kind: 'rejected'; error: unknown }
  /** Settled after the soft deadline: too late to trust, safe to follow. */
  | { kind: 'late'; outcome: { kind: 'value'; value: T } | { kind: 'rejected'; error: unknown } }
  /** Still pending at the hard cap (only when one was given). Whatever follows may overlap it. */
  | { kind: 'abandoned' };

/** A render call's result is trusted only when it came back `true`, in time. */
export const accepted = (r: Settled<boolean>): boolean => r.kind === 'value' && r.value === true;

export async function settleWithin<T>(p: Promise<T>, softMs: number, hardMs?: number): Promise<Settled<T>> {
  const settled: Promise<{ kind: 'value'; value: T } | { kind: 'rejected'; error: unknown }> = p.then(
    (value) => ({ kind: 'value' as const, value }),
    (error) => ({ kind: 'rejected' as const, error }),
  );
  const after = <K extends string>(ms: number, kind: K) => {
    let timer: ReturnType<typeof setTimeout>;
    const promise = new Promise<K>((r) => { timer = setTimeout(() => r(kind), ms); });
    return { promise, cancel: () => clearTimeout(timer) };
  };

  const soft = after(softMs, 'soft');
  const first = await Promise.race([settled, soft.promise]);
  soft.cancel();
  if (first !== 'soft') return first;

  // No hard cap: wait for the call, however long. The queue behind it waits too.
  if (hardMs === undefined) return { kind: 'late', outcome: await settled };

  const hard = after(Math.max(0, hardMs - softMs), 'hard');
  const second = await Promise.race([settled, hard.promise]);
  hard.cancel();
  if (second === 'hard') return { kind: 'abandoned' };
  return { kind: 'late', outcome: second };
}
