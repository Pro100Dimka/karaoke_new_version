import { expect, it } from 'vitest';
import {
  currentLineIndex,
  lyricSilenceSeconds,
  nextLineIndex,
  type LyricLine,
} from './karaokeLyrics';

const line = (start: number, end: number): LyricLine => ({
  words: [],
  start,
  end,
});

// The direct source-order definition also covers overlapping and unsorted
// timings, for which a binary search of line starts would change selection.
const expectedCurrent = (lines: readonly LyricLine[], position: number) => {
  const active = lines.findIndex(
    (entry) => position >= entry.start && position <= entry.end,
  );
  if (active >= 0) return active;
  const next = lines.findIndex((entry) => entry.start > position);
  const before = lines[next - 1];
  const after = lines[next];
  if (
    before &&
    after &&
    position - before.end < lyricSilenceSeconds &&
    after.start - position > lyricSilenceSeconds
  )
    return next - 1;
  return next < 0 ? lines.length - 1 : next;
};

it.each(['ordered', 'reversed', 'overlapping'] as const)(
  'retains source-order lyric selection for %s lines across boundaries and seeks',
  (kind) => {
    const lines = Array.from({ length: 390 }, (_, index) =>
      line(index * 4, index * 4 + 0.75),
    );
    if (kind === 'reversed') lines.reverse();
    if (kind === 'overlapping') {
      lines[0] = line(900, 902);
      lines[127] = line(10, 1300);
      lines[128] = line(10, 10.75);
      lines[255] = line(10, 1300);
      lines[256] = line(900, 902);
    }
    const positions = [
      -1,
      ...lines.flatMap(({ start, end }) => [
        start - 1e-7,
        start,
        start + 1e-7,
        end - 1e-7,
        end,
        end + 1e-7,
        end + lyricSilenceSeconds,
      ]),
      2000,
      10,
      902,
      0,
    ];
    for (const position of positions) {
      expect(currentLineIndex(lines, position), `current at ${position}`).toBe(
        expectedCurrent(lines, position),
      );
      expect(nextLineIndex(lines, position), `next at ${position}`).toBe(
        lines.findIndex((entry) => entry.start > position),
      );
    }
  },
);

it('uses new line timings when replacing a document and supports empty lyrics', () => {
  const previous = [line(0, 1), line(5, 6)];
  expect(currentLineIndex(previous, 0.5)).toBe(0);
  expect(nextLineIndex(previous, 0.5)).toBe(1);
  const replacement = [line(20, 21), line(0, 1)];
  expect(currentLineIndex(replacement, 0.5)).toBe(1);
  expect(nextLineIndex(replacement, 0.5)).toBe(0);
  expect(currentLineIndex([], 0.5)).toBe(-1);
  expect(nextLineIndex([], 0.5)).toBe(-1);
});
