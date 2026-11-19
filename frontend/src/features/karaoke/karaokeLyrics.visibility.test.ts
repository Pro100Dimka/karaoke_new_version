import { describe, expect, it } from 'vitest';
import {
  buildLines,
  currentLineIndex,
  upcomingLinePhase,
} from './karaokeLyrics';
import { word } from './karaokeLyricsFixture';

describe('overlapping saved lyric words', () => {
  const words = [
    word('held', 0, 5),
    word('reply', 0.5, 1),
    word('next', 10, 11),
  ];
  const lyrics = 'held reply\nnext';

  it('keeps a held word visible until its own end when a later word ends sooner', () => {
    const lines = buildLines(words, lyrics);
    const index = currentLineIndex(lines, 4.5);

    expect(lines[index]?.words).toContain(words[0]);
    expect(upcomingLinePhase(lines, index, 4.5)).toEqual({ kind: 'text' });
    expect(lines.flatMap((line) => line.words)).toEqual(words);
    expect(currentLineIndex(lines, 10.5)).toBe(1);
  });

  it('retains a phrase when activity supports the held word after the shorter word ends', () => {
    const lines = buildLines(words, lyrics, undefined, [
      [3, 5],
      [10, 11],
    ]);

    expect(lines.flatMap((line) => line.words)).toEqual(words);
    expect(lines[0]?.end).toBe(5);
  });
});
