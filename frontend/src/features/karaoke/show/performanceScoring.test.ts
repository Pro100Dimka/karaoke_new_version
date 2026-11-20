import { afterEach, expect, it, vi } from 'vitest';
import { PerformanceTracker } from './performanceTracker';
import * as scoring from './performanceScoring';
import {
  karaokePitchToleranceSemitones,
  noteHitReached,
} from '../karaokeLyrics';

afterEach(() => vi.restoreAllMocks());

it('does not revisit five minutes of stable pitch samples on each new frame', () => {
  let reads = 0;
  const empty = scoring.emptyProgress;
  vi.spyOn(scoring, 'emptyProgress').mockImplementation(() => {
    const progress = empty();
    progress.deviations = new Proxy(progress.deviations, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    return progress;
  });
  const tracker = new PerformanceTracker();
  tracker.load(
    Array.from({ length: 620 }, (_, index) => ({
      id: `n${index}`,
      start: index / 2,
      end: index / 2 + 0.48,
      pitch: 60,
    })),
    [],
  );
  for (let frame = 0; frame <= 18000; frame++)
    tracker.update(
      frame / 60,
      440 * 2 ** ((60 + 0.4 * Math.sin(frame) - 69) / 12),
    );
  expect(tracker.noteScore.noteStabilityPercent).toBe(100);
  reads = 0;
  for (let frame = 18001; frame <= 18120; frame++) {
    tracker.update(
      frame / 60,
      440 * 2 ** ((60 + 0.4 * Math.sin(frame) - 69) / 12),
    );
    expect(tracker.noteScore.noteStabilityPercent).toBe(100);
  }
  expect(reads).toBeLessThan(1000);
});

const stableReference = (progress: scoring.NoteProgress, mean: number) =>
  progress.deviations.reduce(
    (seconds, [deviation, duration]) =>
      seconds +
      (Math.abs(deviation - mean) <= karaokePitchToleranceSemitones
        ? duration
        : 0),
    0,
  );

const progressOf = (samples: readonly (readonly [number, number])[]) => {
  const progress = {
    ...scoring.emptyProgress(),
    deviationMin: Infinity,
    deviationMax: -Infinity,
  };
  for (const [deviation, duration] of samples) {
    progress.voiced += duration;
    progress.evaluated += duration;
    progress.absoluteDeviation += Math.abs(deviation) * duration;
    progress.deviationSum += deviation * duration;
    if (Math.abs(deviation) <= karaokePitchToleranceSemitones)
      progress.matched += duration;
    progress.deviationMin = Math.min(progress.deviationMin, deviation);
    progress.deviationMax = Math.max(progress.deviationMax, deviation);
    progress.deviations.push([deviation, duration]);
  }
  return progress;
};

it('preserves exact stability at both tolerance edges, shifted means and mixed ranges', () => {
  let seed = 91273;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const fixtures: number[][] = [
    [],
    [0],
    [-1, 1],
    [-1 - Number.EPSILON, 1 + Number.EPSILON],
    [-1 + Number.EPSILON, 1 - Number.EPSILON],
    [2, 3],
    [-3, -2],
    [NaN, 0],
    [Infinity, 0],
    [-Infinity, 0],
    ...Array.from({ length: 256 }, () =>
      Array.from({ length: 120 }, () => (random() - 0.5) * 8),
    ),
  ];
  for (const values of fixtures) {
    const progress = progressOf(
      values.map((value) => [value, 0.001 + random() * 0.02]),
    );
    const mean =
      progress.voiced > 0 ? progress.deviationSum / progress.voiced : 0;
    for (const center of [
      mean,
      -4,
      -1,
      0,
      1,
      4,
      ...values.slice(0, 3).flatMap((value) => [value - 1, value + 1]),
    ])
      expect(scoring.stableSeconds(progress, center)).toBe(
        stableReference(progress, center),
      );
  }
});

/** Original independent per-field reductions, including their exact addition order. */
const totalReference = (
  seen: readonly { note: scoring.ShowNote; progress: scoring.NoteProgress }[],
  durations: WeakMap<scoring.ShowNote, number>,
  ignoreSilence: boolean,
  rhythmIntersection: number,
  rhythmUnion: number,
) => {
  const sum = (value: (progress: scoring.NoteProgress) => number) =>
    seen.reduce((total, { progress }) => total + value(progress), 0);
  const voiced = sum((progress) => progress.voiced);
  const evaluated = sum((progress) => progress.evaluated);
  const mean =
    voiced > 0 ? sum((progress) => progress.deviationSum) / voiced : 0;
  return {
    version: 3,
    ...(ignoreSilence ? { ignoreSilence: true } : {}),
    expectedPitchSeconds: evaluated + sum((progress) => progress.uncertain),
    assessedPitchSeconds: evaluated,
    pitchAccuracyPercent:
      evaluated > 0
        ? 100 * Math.min(1, sum((progress) => progress.matched) / evaluated)
        : 0,
    meanSemitoneDeviation:
      sum((progress) => progress.absoluteDeviation) / Math.max(0.001, voiced),
    hitNotes: seen.filter(({ note, progress }) =>
      noteHitReached(
        progress.matched,
        scoring.assessedNoteDuration(
          note,
          progress,
          durations.get(note),
          ignoreSilence,
        ),
      ),
    ).length,
    totalNotes: seen.length,
    rhythmAccuracyPercent:
      rhythmUnion > 0 ? 100 * Math.min(1, rhythmIntersection / rhythmUnion) : 0,
    noteStabilityPercent:
      voiced > 0
        ? 100 *
          Math.min(
            1,
            sum((progress) => stableReference(progress, mean)) / voiced,
          )
        : 0,
  };
};

it('keeps every total score field exactly equal to the original reductions', () => {
  const durations = new WeakMap<scoring.ShowNote, number>();
  const seen = Array.from({ length: 120 }, (_, index) => {
    const note = { id: `n${index}`, start: index, end: index + 0.8, pitch: 60 };
    durations.set(note, 0.8);
    const progress = progressOf(
      Array.from({ length: index % 60 }, (_, frame) => [
        Math.sin(frame + index) * (index % 5),
        0.01 + frame / 10000,
      ]),
    );
    progress.uncertain = index % 3 ? 0 : 0.041;
    progress.evaluated += index % 2 ? 0.034 : 0;
    return { note, progress };
  });
  for (const ignoreSilence of [false, true])
    for (const count of [0, 1, 10, 30, 60, 120])
      for (const [intersection, union] of [
        [0, 0],
        [3.2, 9.1],
        [9.1, 9.1],
      ] as const) {
        const notes = seen.slice(0, count);
        expect(
          scoring.totalNoteScore(
            notes,
            durations,
            ignoreSilence,
            intersection,
            union,
          ),
        ).toEqual(
          totalReference(notes, durations, ignoreSilence, intersection, union),
        );
      }
});
