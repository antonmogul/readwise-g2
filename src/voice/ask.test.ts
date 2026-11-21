import { describe, it, expect } from 'vitest';
import { heardWords, isQuestion, isCurrent, MIN_UTTERANCE_BYTES } from './ask';
import { BYTES_PER_SECOND } from './utterance';

describe('heardWords', () => {
  // whisper writes noise as "(upbeat music)" or "[BLANK_AUDIO]" — not a question.
  it('drops bracketed asides and punctuation, keeping letters and digits', () => {
    expect(heardWords('(upbeat music)')).toBe('');
    expect(heardWords('[BLANK_AUDIO]')).toBe('');
    expect(heardWords('what have I read about sleep?')).toBe('whathaveIreadaboutsleep');
    expect(heardWords('something from 2024, please')).toBe('somethingfrom2024please');
  });
});

describe('isQuestion', () => {
  it('needs at least two heard characters', () => {
    expect(isQuestion('(sighs) a')).toBe(false);
    expect(isQuestion('ok')).toBe(true);
    expect(isQuestion('find me something short about cities')).toBe(true);
  });
});

describe('isCurrent', () => {
  // A late result from a cancelled question must not paint over the screen.
  it('accepts only the sequence that started the step', () => {
    expect(isCurrent(3, 3)).toBe(true);
    expect(isCurrent(2, 3)).toBe(false);
  });
});

describe('MIN_UTTERANCE_BYTES', () => {
  it('is a quarter second of 16 kHz s16le mono', () => {
    expect(MIN_UTTERANCE_BYTES).toBe(BYTES_PER_SECOND / 4);
    expect(MIN_UTTERANCE_BYTES).toBe(8000);
  });
});
