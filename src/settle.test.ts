import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { settleWithin, accepted } from './settle';

describe('settleWithin without a hard cap — a render call is never given up on', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  // Giving up at a hard cap and rebuilding let a late upgrade overwrite the
  // rebuilt screen. The queue waits on the stuck call instead, however long.
  it('stays pending for as long as the call does, then reports it late', async () => {
    let resolve!: (v: boolean) => void;
    const call = new Promise<boolean>((r) => { resolve = r; });
    let settled = false;
    const p = settleWithin(call, 5000).then((r) => { settled = true; return r; });
    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(settled).toBe(false);
    resolve(true);
    expect(await p).toEqual({ kind: 'late', outcome: { kind: 'value', value: true } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never reports abandoned', async () => {
    let reject!: (e: unknown) => void;
    const call = new Promise<boolean>((_, rej) => { reject = rej; });
    const p = settleWithin(call, 5000);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    reject(new Error('finally'));
    expect(await p).toMatchObject({ kind: 'late', outcome: { kind: 'rejected' } });
  });
});

describe('accepted — what a render may trust', () => {
  it('is only a true value in time; late, false, rejected and abandoned all fall back', () => {
    expect(accepted({ kind: 'value', value: true })).toBe(true);
    expect(accepted({ kind: 'value', value: false })).toBe(false);
    expect(accepted({ kind: 'rejected', error: new Error('x') })).toBe(false);
    expect(accepted({ kind: 'late', outcome: { kind: 'value', value: true } })).toBe(false);
    expect(accepted({ kind: 'abandoned' })).toBe(false);
  });
});

describe('settleWithin — a slow bridge call is waited out, not overlapped', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const deferred = <T,>() => {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };

  it('passes a value through within the soft deadline', async () => {
    const d = deferred<boolean>();
    const p = settleWithin(d.promise, 5000, 30000);
    d.resolve(true);
    expect(await p).toEqual({ kind: 'value', value: true });
  });

  it('passes a rejection through at once', async () => {
    const d = deferred<boolean>();
    const p = settleWithin(d.promise, 5000, 30000);
    d.reject(new Error('refused'));
    expect(await p).toMatchObject({ kind: 'rejected' });
  });

  // THE bug: the old withTimeout rejected at 5s and the rebuild that followed
  // ran while the upgrade was still in flight on the bridge.
  it('does not resolve at the soft deadline while the call is still pending', async () => {
    const d = deferred<boolean>();
    let settled = false;
    const p = settleWithin(d.promise, 5000, 30000).then((r) => { settled = true; return r; });
    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10000);
    expect(settled).toBe(false);
    d.resolve(true);
    const r = await p;
    expect(settled).toBe(true);
    expect(r).toEqual({ kind: 'late', outcome: { kind: 'value', value: true } });
  });

  it('reports a late rejection as late, so the fallback still runs after it', async () => {
    const d = deferred<boolean>();
    const p = settleWithin(d.promise, 5000, 30000);
    await vi.advanceTimersByTimeAsync(6000);
    d.reject(new Error('eventually'));
    expect(await p).toMatchObject({ kind: 'late', outcome: { kind: 'rejected' } });
  });

  it('abandons a call that never settles at the hard cap, and not before', async () => {
    const d = deferred<boolean>();
    let settled = false;
    const p = settleWithin(d.promise, 5000, 30000).then((r) => { settled = true; return r; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ kind: 'abandoned' });
  });

  it('leaves no timers behind once settled', async () => {
    const d = deferred<boolean>();
    const p = settleWithin(d.promise, 5000, 30000);
    d.resolve(false);
    await p;
    expect(vi.getTimerCount()).toBe(0);
  });
});
