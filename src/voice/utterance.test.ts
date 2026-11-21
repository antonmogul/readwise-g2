import { describe, it, expect } from 'vitest';
import {
  utterance, level, endpointer, BYTES_PER_SECOND, MAX_SECONDS, ENDPOINT,
  type EndpointState,
} from './utterance';

/** s16le mono PCM: a 220 Hz tone at `amp` of full scale — a stand-in for a voice. */
function tone(ms: number, amp: number): Uint8Array {
  const n = Math.round((ms / 1000) * 16_000);
  const out = new Uint8Array(n * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < n; i++) {
    view.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * 220 * i) / 16_000) * amp * 32767), true);
  }
  return out;
}

/** Deterministic hiss at `amp` of full scale — a room that is never silent. */
function hiss(ms: number, amp: number, seed = 7): Uint8Array {
  const n = Math.round((ms / 1000) * 16_000);
  const out = new Uint8Array(n * 2);
  const view = new DataView(out.buffer);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    view.setInt16(i * 2, Math.round(((x / 0x7fffffff) * 2 - 1) * amp * 32767), true);
  }
  return out;
}

/** Cut audio into frames of `frameMs`, as the SDK would deliver it. */
function frames(pcm: Uint8Array, frameMs = 100): Uint8Array[] {
  const size = Math.round((frameMs / 1000) * BYTES_PER_SECOND);
  const out: Uint8Array[] = [];
  for (let i = 0; i < pcm.length; i += size) out.push(pcm.subarray(i, i + size));
  return out;
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/** Feed audio through a fresh endpointer; return every state it reported. */
function run(pcm: Uint8Array, frameMs = 100): EndpointState[] {
  const ep = endpointer();
  return frames(pcm, frameMs).map((f) => ep.feed(f));
}
const final = (states: EndpointState[]) => states[states.length - 1];
/** When (ms into the audio) the endpointer first said `state`. */
const when = (states: EndpointState[], state: EndpointState, frameMs = 100) =>
  states.indexOf(state) * frameMs;

describe('utterance', () => {
  it('copies each frame — the SDK may reuse its buffer after the callback', () => {
    const u = utterance();
    const frame = new Uint8Array([1, 2, 3, 4]);
    u.push(frame);
    frame.fill(0);
    expect([...u.pcm()]).toEqual([1, 2, 3, 4]);
  });

  it('joins frames in order', () => {
    const u = utterance();
    u.push(new Uint8Array([1, 2]));
    u.push(new Uint8Array([3, 4]));
    expect([...u.pcm()]).toEqual([1, 2, 3, 4]);
    expect(u.bytes).toBe(4);
  });

  it('stops at the cap and says so', () => {
    const u = utterance();
    for (const f of frames(hiss((MAX_SECONDS + 2) * 1000, 0.1), 250)) u.push(f);
    expect(u.bytes).toBe(MAX_SECONDS * BYTES_PER_SECOND);
    expect(u.seconds).toBe(MAX_SECONDS);
    expect(u.truncated).toBe(true);
  });

  it('keeps the recording under the board\'s 2 MB upload limit', () => {
    expect(MAX_SECONDS * BYTES_PER_SECOND).toBeLessThan(2_000_000);
  });
});

describe('level', () => {
  it('is 0 for silence and for an empty frame', () => {
    expect(level(new Uint8Array(3200))).toBe(0);
    expect(level(new Uint8Array(0))).toBe(0);
  });

  it('measures RMS against full scale', () => {
    // A sine's RMS is its amplitude over √2.
    expect(level(tone(100, 0.5))).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });

  it('reads a frame that is a view into a larger buffer', () => {
    const big = concat(new Uint8Array(1000), tone(100, 0.5));
    expect(level(big.subarray(1000))).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });
});

describe('endpointer', () => {
  const room = (ms: number) => hiss(ms, 0.005);

  it('ends the question after a pause that follows speech', () => {
    const states = run(concat(room(500), tone(1500, 0.2), room(2000)));
    expect(states).toContain('speaking');
    expect(final(states)).toBe('done');
    // 500ms room + 1500ms speech, then ENDPOINT.silenceMs of quiet.
    expect(when(states, 'done')).toBeGreaterThanOrEqual(2000 + ENDPOINT.silenceMs - 200);
    expect(when(states, 'done')).toBeLessThanOrEqual(2000 + ENDPOINT.silenceMs + 200);
  });

  it('keeps listening through the short gaps between words', () => {
    const words = concat(...Array.from({ length: 6 }, () => concat(tone(400, 0.2), room(300))));
    const states = run(concat(room(300), words));
    expect(states).not.toContain('done');
    expect(final(states)).toBe('speaking');
  });

  it('does not treat a cough-length blip as a question', () => {
    const states = run(concat(room(500), tone(200, 0.3), room(3000)));
    expect(states).not.toContain('done');
    expect(states).not.toContain('speaking');
  });

  it('gives up when nothing is said', () => {
    const states = run(room(ENDPOINT.noSpeechMs + 500));
    expect(final(states)).toBe('nothing');
  });

  // A café is never silent. A fixed threshold would hear the room as speech
  // and never see the pause; the floor is learned from the room instead.
  it('learns a noisy room rather than hearing it as speech', () => {
    const cafe = (ms: number) => hiss(ms, 0.06);
    const states = run(concat(cafe(1000), tone(1500, 0.4), cafe(2500)));
    expect(states.slice(0, 10)).not.toContain('speaking');
    expect(final(states)).toBe('done');
  });

  it('hears a question that starts on the very first frame', () => {
    const words = concat(...Array.from({ length: 5 }, () => concat(tone(400, 0.2), room(150))));
    expect(final(run(concat(words, room(2000))))).toBe('done');
  });

  it('times by bytes, so frame size does not change the outcome', () => {
    const audio = concat(room(500), tone(1500, 0.2), room(2000));
    const at100 = run(audio, 100);
    const at20 = run(audio, 20);
    expect(final(at20)).toBe('done');
    expect(Math.abs(when(at20, 'done', 20) - when(at100, 'done', 100))).toBeLessThanOrEqual(120);
  });

  it('stays done once done', () => {
    const ep = endpointer();
    for (const f of frames(concat(room(300), tone(1000, 0.2), room(2000)))) ep.feed(f);
    expect(ep.feed(tone(500, 0.5))).toBe('done');
  });
});
