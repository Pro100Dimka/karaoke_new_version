import { describe, expect, it } from 'vitest';
import { word } from './karaokeLyricsFixture';
import { syllableProgress } from './karaokeLyrics';
describe('syllable fill', () => {
  it('holds a sung number through its word interval instead of rushing through its digits', () => {
    const saved = word('100', 0, 2);
    expect(syllableProgress(saved, 0.16)).toBeLessThan(0.5);
    expect(syllableProgress(saved, 1)).toBeCloseTo(0.5);
    expect(syllableProgress(saved, 1.9)).toBeLessThan(1);
    expect(syllableProgress(saved, 2)).toBe(1);
  });
  it('holds the vowel inside its actual glyph when adjacent consonants are wider', () => {
    const saved = word('Твій', 0, 2);
    const geometry = [
      [0, 0.3],
      [0.3, 0.6],
      [0.6, 0.7],
      [0.7, 1],
    ] as const;
    for (const at of [0.4, 1, 1.6]) {
      expect(syllableProgress(saved, at, geometry)).toBeGreaterThan(0.6);
      expect(syllableProgress(saved, at, geometry)).toBeLessThan(0.7);
    }
  });
  it.each([
    { text: 'так', duration: 0.08 },
    { text: 'ТВІЙ', duration: 2 },
    { text: '«льоту!»', duration: 0.84 },
    { text: 'ш', duration: 1 },
    { text: '100', duration: 1.5 },
    { text: 'ААА', duration: 3 },
  ])(
    'keeps $text continuous and bounded at its own tempo',
    ({ text, duration }) => {
      const saved = Object.freeze({ ...word(text, 5, 5 + duration) });
      let previous = 0;
      for (let frame = 0; frame <= Math.ceil(duration * 60); frame++) {
        const at = Math.min(saved.end, saved.start + frame / 60);
        const progress = syllableProgress(saved, at);
        expect(Number.isFinite(progress)).toBe(true);
        expect(progress).toBeGreaterThanOrEqual(previous - 1e-9);
        expect(progress).toBeGreaterThanOrEqual(0);
        expect(progress).toBeLessThanOrEqual(1);
        previous = progress;
      }
      expect(syllableProgress(saved, saved.end)).toBe(1);
      expect(saved.start).toBe(5);
      expect(saved.end).toBe(5 + duration);
    },
  );
  it('gives an opening consonant a visible sweep before holding the vowel', () => {
    const saved = word('так', 0, 2);
    expect(syllableProgress(saved, 0.07)).toBeGreaterThan(0);
    expect(syllableProgress(saved, 0.07)).toBeLessThan(1 / 3);
    expect(syllableProgress(saved, 0.14)).toBeCloseTo(1 / 3);
    expect(syllableProgress(saved, 1)).toBeGreaterThan(1 / 3);
    expect(syllableProgress(saved, 1)).toBeLessThan(2 / 3);
  });
  it.each(['так', 'ТВІЙ', 'шаг', 'big'])(
    'keeps the held part of %s on its vowel instead of its consonants',
    (text) => {
      const saved = Object.freeze({
        ...word(text, 0, 2),
        letters: Object.freeze([...text].map((_, i) => i / text.length)),
      });
      const vowel = [...text].findIndex((c) =>
        /[aeiouyаеёиоуыэюяіїє]/i.test(c),
      );
      for (const at of [0.3, 1, 1.7]) {
        expect(syllableProgress(saved, at)).toBeGreaterThan(
          vowel / text.length,
        );
        expect(syllableProgress(saved, at)).toBeLessThan(
          (vowel + 1) / text.length,
        );
      }
      expect(syllableProgress(saved, 0)).toBe(0);
      expect(syllableProgress(saved, 2)).toBe(1);
    },
  );
  it.each(['в', 'г', 'ш'])(
    'passes a consonant-only %s briefly without advancing the next word',
    (text) => {
      const saved = word(text, 0, 1);
      expect(syllableProgress(saved, 0)).toBe(0);
      expect(syllableProgress(saved, 0.08)).toBeGreaterThan(0);
      expect(syllableProgress(saved, 0.08)).toBeLessThan(1);
      expect(syllableProgress(saved, 0.16)).toBe(1);
      expect(syllableProgress(word('так', 1, 2), 0.5)).toBe(0);
      expect(saved.end).toBe(1);
    },
  );
  it('keeps measured syllable entries while spending each hold on its vowel', () => {
    const saved = { ...word('тобі', 0, 1), letters: [0, 0.08, 0.16, 0.26] };
    expect(syllableProgress(saved, 0.16)).toBeCloseTo(0.5);
    expect(syllableProgress(saved, 0.2)).toBeLessThan(0.75);
    expect(syllableProgress(saved, 0.34)).toBeGreaterThan(0.75);
    expect(syllableProgress(saved, 0.8)).toBeLessThan(1);
  });
  it.each(['тобі', 'тоби'])(
    'keeps measured syllable entries in %s and gives the held part to its vowel',
    (text) => {
      const saved = { ...word(text, 0, 1), letters: [0, 0.08, 0.16, 0.26] };
      expect(syllableProgress(saved, 0.16)).toBeCloseTo(0.5);
      expect(syllableProgress(saved, 0.26)).toBeCloseTo(
        0.5 + (0.25 * 0.1) / 0.14,
      );
      expect(syllableProgress(saved, 0.63)).toBeCloseTo(
        0.75 + (0.25 * 0.33) / 0.7,
      );
      expect(syllableProgress(saved, 1)).toBe(1);
    },
  );
  it('keeps the held vowel active before passing the closing consonant', () => {
    const saved = { ...word('дим', 0, 1), letters: [0, 0.1, 0.2] };
    expect(syllableProgress(saved, 0.2)).toBeCloseTo(1 / 3 + 0.06 / 0.72 / 3);
    expect(syllableProgress(saved, 0.6)).toBeCloseTo(1 / 3 + 0.46 / 0.72 / 3);
    expect(syllableProgress(saved, 0.94)).toBeGreaterThan(2 / 3);
  });
  it.each([{ letters: [0, 0.2, 1, 1] }, { letters: [0, 0, 0, 0] }])(
    'keeps unresolved syllables continuous within the word: $letters',
    ({ letters }) => {
      const saved = { ...word('мама', 0, 1), letters };
      expect(syllableProgress(saved, 0.5)).toBeCloseTo(0.5);
      expect(syllableProgress(saved, 0.99)).toBeCloseTo(
        0.75 + (0.25 * 0.35) / 0.36,
      );
    },
  );
  it.each([
    {
      text: 'льоту',
      end: 0.84,
      letters: [0, 0.08, 0.08, 0.22, 0.34],
      at: 0.11,
      expected: 2 / 5 + ((1 / 5) * 0.022) / 0.132,
    },
    {
      text: 'слухала',
      end: 0.7,
      letters: [0, 0.2, 0.22, 0.36, 0.44, 0.54, 0.6],
      at: 0.18,
      expected: 2 / 7 + ((1 / 7) * 0.036) / 0.216,
    },
    {
      text: 'Так',
      end: 0.22,
      letters: [0, 0.08, 0.1],
      at: 0.11,
      expected: 0.5,
    },
  ])(
    'fills short clusters in $text smoothly within measured syllable boundaries',
    ({ text, end, letters, at, expected }) => {
      const saved = Object.freeze({
        ...word(text, 0, end),
        letters: Object.freeze(letters.map((t) => t / end)),
      });
      const geometry = [...text].map(
        (_, i) => [i / text.length, (i + 1) / text.length] as const,
      );
      expect(syllableProgress(saved, at, geometry)).toBeCloseTo(expected);
      expect(syllableProgress(saved, 0, geometry)).toBe(0);
      expect(syllableProgress(saved, end, geometry)).toBe(1);
    },
  );
});

it('fills an elongated vowel notation as one sung sound instead of six rapid syllables', () => {
  const saved = {
    ...word('ОООООО', 0, 6),
    letters: [0, 0.01, 0.04, 0.06, 0.07, 0.1],
  };
  expect(syllableProgress(saved, 3)).toBeCloseTo(0.5);
  expect(syllableProgress(saved, 5)).toBeCloseTo(5 / 6);
});

it('does not flash the last half of a syllable when CTC puts its vowel at the word end', () => {
  const saved = Object.freeze({
    ...word('me', 0, 0.6),
    letters: Object.freeze([0, 0.58 / 0.6]),
  });
  expect(syllableProgress(saved, 0.14)).toBeCloseTo(0.5);
  expect(syllableProgress(saved, 0.3)).toBeCloseTo(0.5 + (0.5 * 0.16) / 0.46);
  let previous = syllableProgress(saved, 0.15);
  for (let frame = 10; frame <= 36; frame++) {
    const progress = syllableProgress(saved, frame / 60);
    expect(progress - previous).toBeLessThan(0.04);
    previous = progress;
  }
});
