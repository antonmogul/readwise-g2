/**
 * A spoken question, as it arrives from the G2 microphone.
 *
 * Pure: frames in, bytes and decisions out. `main.ts` owns the microphone; this
 * owns what a question IS — how long it may run, and when it has ended — so
 * both can be asserted without glasses, a mic or a clock.
 *
 * The SDK delivers PCM on `audioEvent.audioPcm`: 16 kHz, signed 16-bit
 * little-endian, mono (Even Hub docs, "Device APIs"). The board's
 * `/api/transcribe` takes exactly that as `application/octet-stream`, so no
 * WAV header or base64 is built here — base64 alone would inflate the upload
 * by a third.
 */

export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SECOND = SAMPLE_RATE * 2;

/**
 * Longest question kept. The board refuses bodies over 2,000,000 bytes (~62s);
 * a question is a sentence or two, and a recording still running at 30s is a
 * mic nobody stopped, not a question.
 */
export const MAX_SECONDS = 30;

export type Utterance = {
  /** Add a frame. Copied: the SDK may reuse the buffer after the callback. */
  push(frame: Uint8Array): void;
  readonly bytes: number;
  readonly seconds: number;
  /** True once frames were dropped at the cap. */
  readonly truncated: boolean;
  /** The whole recording, one contiguous buffer. */
  pcm(): Uint8Array;
};

export function utterance(maxSeconds = MAX_SECONDS): Utterance {
  const max = Math.floor(maxSeconds * BYTES_PER_SECOND);
  const frames: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  return {
    push(frame) {
      if (bytes >= max) { truncated = true; return; }
      const room = max - bytes;
      // `slice` copies. brain-even-hub copied every frame after finding the
      // SDK may reuse the frame buffer once the callback returns (677f6d3).
      const kept = frame.length > room ? frame.slice(0, room) : frame.slice();
      if (kept.length < frame.length) truncated = true;
      frames.push(kept);
      bytes += kept.length;
    },
    get bytes() { return bytes; },
    get seconds() { return bytes / BYTES_PER_SECOND; },
    get truncated() { return truncated; },
    pcm() {
      const out = new Uint8Array(bytes);
      let at = 0;
      for (const f of frames) { out.set(f, at); at += f.length; }
      return out;
    },
  };
}

/** Loudness of one frame, 0..1: the RMS of its samples against full scale. */
export function level(frame: Uint8Array): number {
  const n = Math.floor(frame.length / 2);
  if (n === 0) return 0;
  const view = new DataView(frame.buffer, frame.byteOffset, n * 2);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = view.getInt16(i * 2, true) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

export type EndpointState = 'waiting' | 'speaking' | 'done' | 'nothing';

export type EndpointOptions = {
  /** Quiet after speech that ends the question. */
  silenceMs: number;
  /** Speech needed before a pause can end anything — a cough is not a question. */
  minSpeechMs: number;
  /** Give up if no speech has started by then. */
  noSpeechMs: number;
  /** Speech is this many times the room's level… */
  ratio: number;
  /** …and never quieter than this, so a silent room's hiss is not speech. */
  minLevel: number;
  /** How far back the room's level is measured. */
  floorWindowMs: number;
};

/**
 * Defaults. Chosen against synthetic audio, NOT yet tuned on glasses — the G2
 * mic's levels, gain and noise suppression are unmeasured. Press always sends,
 * so a detector that is too patient costs a press, never the question.
 */
export const ENDPOINT: EndpointOptions = {
  silenceMs: 1400,
  minSpeechMs: 300,
  noSpeechMs: 8000,
  ratio: 3,
  minLevel: 0.01,
  floorWindowMs: 3000,
};

export type Endpointer = { feed(frame: Uint8Array): EndpointState };

/**
 * When has he stopped talking?
 *
 * The room is learned rather than assumed: a café is never silent, so a fixed
 * threshold either hears the espresso machine as a question or misses a quiet
 * voice. The room's level is the QUIETEST frame of the last few seconds — the
 * gaps between words reveal it even while he talks, and a voice cannot drag it
 * up the way an average would. Speech is anything well above it.
 *
 * Timing comes from byte counts, not a clock: frame sizes on hardware are
 * unknown, and a timer-paced feed starves in the simulator (brain-even-hub).
 */
export function endpointer(opts: EndpointOptions = ENDPOINT): Endpointer {
  const recent: Array<{ ms: number; level: number }> = [];
  let windowMs = 0;
  let elapsed = 0;
  let speech = 0;
  let quiet = 0;
  let heard = false;
  let state: EndpointState = 'waiting';

  return {
    feed(frame) {
      if (state === 'done' || state === 'nothing') return state;
      const ms = (frame.length / BYTES_PER_SECOND) * 1000;
      const l = level(frame);
      elapsed += ms;
      recent.push({ ms, level: l });
      windowMs += ms;
      while (recent.length > 1 && windowMs - recent[0].ms >= opts.floorWindowMs) {
        windowMs -= recent.shift()!.ms;
      }
      const floor = Math.min(...recent.map((r) => r.level));
      const loud = l > Math.max(opts.minLevel, floor * opts.ratio);

      if (loud) {
        speech += ms;
        quiet = 0;
        if (speech >= opts.minSpeechMs) heard = true;
      } else {
        quiet += ms;
        // A blip that never reached minSpeechMs does not count as speech.
        if (!heard) speech = 0;
      }

      if (heard && quiet >= opts.silenceMs) state = 'done';
      else if (!heard && elapsed >= opts.noSpeechMs) state = 'nothing';
      else state = heard ? 'speaking' : 'waiting';
      return state;
    },
  };
}
