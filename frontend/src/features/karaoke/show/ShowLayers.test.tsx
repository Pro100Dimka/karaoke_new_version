import { renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { PitchFrame } from '../../../contracts/models';
import type { LyricLine } from '../karaokeLyrics';
import { useShowEngine } from './ShowLayers';

vi.mock('../../../app/backdrop/spectrumEvents', () => ({
  subscribeSpectrum: () => () => undefined,
}));

it('resets a new room performance without scoring buffered frames from the previous run', () => {
  const notes = [{ id: 'note', start: 0, end: 1, pitch: 69 }];
  const lines: LyricLine[] = [];
  const settings = { intensity: 'full' as const, reducedMotion: true };
  const { result, rerender } = renderHook(
    ({
      performanceId,
      pitchFrames,
    }: {
      performanceId: number;
      pitchFrames: PitchFrame[];
    }) =>
      useShowEngine({
        notes,
        lines,
        settings,
        position: 0,
        playing: true,
        pitchHz: undefined,
        pitchFrames,
        ignoreSilence: true,
        performanceId,
      }),
    { initialProps: { performanceId: 1, pitchFrames: [] as PitchFrame[] } },
  );
  const frames: PitchFrame[] = [1, 2].map((sequence) => ({
    sequence,
    epoch: 1,
    positionSeconds: (sequence - 0.5) * 0.05,
    durationSeconds: 0.05,
    pitchHz: 440,
    audioActive: true,
  }));
  rerender({ performanceId: 1, pitchFrames: frames });
  expect(result.current.noteScore.assessedPitchSeconds).toBeCloseTo(0.1);
  rerender({ performanceId: 2, pitchFrames: frames });
  expect(result.current.noteScore.assessedPitchSeconds).toBe(0);
  rerender({
    performanceId: 2,
    pitchFrames: [
      ...frames,
      { ...frames[1]!, sequence: 3, positionSeconds: 0.125 },
    ],
  });
  expect(result.current.noteScore.assessedPitchSeconds).toBeCloseTo(0.05);
});
