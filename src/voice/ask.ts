/**
 * The decisions in the asking flow that do not need the bridge, pulled out of
 * `main.ts` so they can be asserted: `main.ts` top-level-awaits the bridge,
 * and a test importing it would hang. The flow itself — open the mic, send,
 * transcribe, search, answer — stays in the shell, because every step of it is
 * a bridge or board call.
 */

import { BYTES_PER_SECOND } from './utterance';

/**
 * Fewer bytes than this and nothing was said: a press straight after the mic
 * opened. A quarter second of 16 kHz s16le mono.
 */
export const MIN_UTTERANCE_BYTES = BYTES_PER_SECOND / 4;

/**
 * The letters and digits whisper actually heard. It writes noise as
 * "(upbeat music)" or "[BLANK_AUDIO]", and that is not a question either —
 * bracketed asides are dropped before counting.
 */
export function heardWords(transcript: string): string {
  return transcript
    .replace(/\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** True when a transcript carries enough to search for. */
export const isQuestion = (transcript: string): boolean => heardWords(transcript).length >= 2;

/**
 * A result from an asynchronous step belongs to the question that started it.
 * Cancelling or asking again moves the sequence on, and anything carrying an
 * older number is dropped rather than painted over the screen the user moved
 * to. Pure, so the guard itself is tested rather than trusted.
 */
export const isCurrent = (seq: number, current: number): boolean => seq === current;
