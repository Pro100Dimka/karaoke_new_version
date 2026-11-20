import { afterEach, expect, it, vi } from 'vitest';
import { PerformanceTracker } from './performanceTracker';
import * as scoring from './performanceScoring';

afterEach(() => vi.restoreAllMocks());

it('reuses the measured history while active samples update its existing note accumulators', () => {
  const total = vi.spyOn(scoring, 'totalNoteScore');
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
    tracker.update(frame / 60, 261.625565);
  const before = tracker.noteScore.assessedPitchSeconds;
  if (before === undefined) throw new Error('Expected measured pitch time');
  total.mockClear();
  for (let frame = 18001; frame <= 18120; frame++) {
    tracker.update(frame / 60, 261.625565);
    expect(tracker.noteScore.assessedPitchSeconds).toBeGreaterThan(before);
  }
  expect(total.mock.calls.length).toBe(120);
  // New notes may extend the history; frames within one note only mutate the
  // referenced accumulator and need no fresh copy of every previous entry.
  expect(new Set(total.mock.calls.map(([seen]) => seen)).size).toBe(4);
});

it('refreshes measured entries after ignored silence, document changes, seeks and a reset', () => {
  const tracker = new PerformanceTracker();
  const notes = [
    { id: 'a', start: 0, end: 2, pitch: 60 },
    { id: 'b', start: 2, end: 4, pitch: 62 },
  ];
  tracker.load(notes, [], true, undefined, true);
  tracker.update(0, undefined, undefined, false);
  tracker.update(0.1, undefined, undefined, false);
  expect(tracker.noteScore.totalNotes).toBe(0);
  tracker.update(0.2, 261.625565);
  expect(tracker.noteScore.totalNotes).toBe(1);
  tracker.update(0.3, 261.625565);
  expect(tracker.noteScore.assessedPitchSeconds).toBeCloseTo(0.2, 12);

  // A same-performance document replacement can remove and restore a note.
  tracker.load([notes[1]!], [], false, undefined, true);
  expect(tracker.noteScore.totalNotes).toBe(0);
  tracker.load(notes, [], false, undefined, true);
  expect(tracker.noteScore.totalNotes).toBe(1);

  tracker.update(0.05, 261.625565);
  expect(tracker.noteScore.totalNotes).toBe(1);
  tracker.update(0.15, 261.625565);
  expect(tracker.noteScore.totalNotes).toBe(2);
  expect(tracker.noteScore.assessedPitchSeconds).toBeCloseTo(0.3, 12);

  tracker.load(notes, [], true, undefined, true);
  expect(tracker.noteScore.totalNotes).toBe(0);
  expect(tracker.noteScore.assessedPitchSeconds).toBe(0);
});
