import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { SongDto } from '../../../contracts/models';
import { SongStrip } from './SongStrip';

const source = vi.hoisted(() => ({ peaks: null as readonly number[] | null }));
vi.mock('../../../shared/hooks/useWaveformPeaks', () => ({
  useWaveformPeaks: () => source.peaks,
}));

afterEach(() => {
  source.peaks = null;
  vi.restoreAllMocks();
});

it('keeps waveform geometry stable across playback frames while peaks are missing and after they arrive', () => {
  const song = {
    id: 'song',
    title: 'Song',
    artist: 'Singer',
    activeRevision: 1,
  } as SongDto;
  const seek = vi.fn();
  const stage = (position: number) => (
    <SongStrip
      song={song}
      position={position}
      duration={240}
      locked={false}
      playing
      onSeek={seek}
    />
  );
  const { rerender } = render(stage(0));
  const coordinates = vi.spyOn(Number.prototype, 'toFixed');

  for (let frame = 1; frame <= 60; frame++) rerender(stage(frame / 60));
  expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '1');
  expect(coordinates.mock.calls.length).toBe(0);

  source.peaks = [0.1, 0.8, 0.4, 0.6];
  rerender(stage(1.1));
  expect(coordinates.mock.calls.length).toBeGreaterThan(0);
  coordinates.mockClear();
  for (let frame = 1; frame <= 60; frame++) rerender(stage(1.1 + frame / 60));
  expect(coordinates.mock.calls.length).toBe(0);

  source.peaks = null;
  rerender(stage(2.2));
  expect(coordinates.mock.calls.length).toBeGreaterThan(0);
  coordinates.mockClear();
  for (let frame = 1; frame <= 60; frame++) rerender(stage(2.2 + frame / 60));
  expect(coordinates.mock.calls.length).toBe(0);
});
