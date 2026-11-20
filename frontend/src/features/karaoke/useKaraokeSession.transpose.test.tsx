import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { tr } from '@neo-ui-kit/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { karaokeRecordingFixtureState } from './karaokeRecordingFixture';
import { useKaraokeSession } from './useKaraokeSession';
import { KaraokeConsole } from './console/KaraokeConsole';
import { audioClient } from '../../services/audioClient';
import { desktopClient } from '../../services/desktopClient';
import { recordingCoordinator } from '../../services/recordingCoordinator';
import type { SongDto } from '../../contracts/models';

const song: SongDto = {
  id: 'song',
  title: 'Transpose test',
  artist: 'Singer',
  language: 'English',
  status: 'ready',
  durationSeconds: 60,
  createdAt: '2026-11-20T00:00:00Z',
  coverState: 'Fallback',
  activeRevision: 1,
  projectFormatVersion: 1,
};

const Console = () => {
  const session = useKaraokeSession(song.id, 'Normal', true);
  return (
    <KaraokeConsole
      song={song}
      state={session.state}
      session={session}
      visible
      controlsVisible
      hasNotes={false}
      hasLyrics={false}
      range={null}
      microphoneAvailable
    />
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  karaokeRecordingFixtureState.roomState.room = null;
  karaokeRecordingFixtureState.roomState.playbackEnabled = false;
  vi.mocked(audioClient.setPitchShift).mockReset().mockResolvedValue(undefined);
  vi.spyOn(desktopClient, 'waveformPeaks').mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

const deferredPitch = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const openConsole = async () => {
  const view = render(<Console />);
  const increase = screen.getByRole('button', { name: tr('transposeUp') });
  await waitFor(() => expect(increase).toBeEnabled());
  const decrease = screen.getByRole('button', { name: tr('transposeDown') });
  return { view, increase, decrease };
};

const requestedKeys = () =>
  vi.mocked(audioClient.setPitchShift).mock.calls.map(([key]) => key);

it.each([
  { label: 'two increases', deltas: [1, 1], expected: 2, keyName: 'D' },
  {
    label: 'increase then decrease',
    deltas: [1, -1],
    expected: 0,
    keyName: 'C',
  },
  {
    label: 'upper limit',
    deltas: Array<number>(13).fill(1),
    expected: 12,
    keyName: 'C',
  },
])(
  'applies rapid enabled transpose clicks: $label',
  async ({ deltas, expected, keyName }) => {
    const pending = deferredPitch();
    vi.mocked(audioClient.setPitchShift).mockImplementation(
      () => pending.promise,
    );
    const { increase, decrease } = await openConsole();

    fireEvent.click(increase);
    await waitFor(() => expect(requestedKeys()).toEqual([1]));
    expect(increase).toBeEnabled();
    for (const delta of deltas.slice(1))
      fireEvent.click(delta === 1 ? increase : decrease);
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });

    await waitFor(() => expect(requestedKeys().at(-1)).toBe(expected), {
      onTimeout: (error) => error,
    });
    expect(screen.getByText(keyName, { selector: 'strong' })).toBeVisible();
    if (expected === 12) expect(increase).toBeDisabled();
  },
);

it.each([1, 2])(
  'recovers after transpose acknowledgement %s fails',
  async (failed) => {
    const pending = deferredPitch();
    vi.mocked(audioClient.setPitchShift).mockImplementationOnce(
      () => pending.promise,
    );
    if (failed === 2)
      vi.mocked(audioClient.setPitchShift).mockRejectedValueOnce(
        new Error('Pitch unavailable'),
      );
    const errors = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const { increase } = await openConsole();
    fireEvent.click(increase);
    await waitFor(() => expect(requestedKeys()).toEqual([1]));
    fireEvent.click(increase);

    await act(async () => {
      if (failed === 1) pending.reject(new Error('Pitch unavailable'));
      else pending.resolve();
      await pending.promise.catch(() => undefined);
    });

    await waitFor(
      () => expect(requestedKeys()).toEqual(failed === 1 ? [1, 1] : [1, 2]),
      { onTimeout: (error) => error },
    );
    expect(screen.getByText('C♯', { selector: 'strong' })).toBeVisible();
    expect(errors).toHaveBeenCalledWith('errors.pitch', expect.any(Error));
    expect(
      vi
        .mocked(recordingCoordinator.updatePlaybackAdjustment)
        .mock.calls.map(([value]) => value.keyShift),
    ).toEqual([1]);

    fireEvent.click(increase);
    await waitFor(() =>
      expect(screen.getByText('D', { selector: 'strong' })).toBeVisible(),
    );
    expect(requestedKeys().at(-1)).toBe(2);
  },
);

it('discards pending transpose clicks after leaving and keeps the next session at its own key', async () => {
  const pending = deferredPitch();
  vi.mocked(audioClient.setPitchShift).mockImplementationOnce(
    () => pending.promise,
  );
  const first = await openConsole();
  fireEvent.click(first.increase);
  await waitFor(() => expect(requestedKeys()).toEqual([1]));
  fireEvent.click(first.increase);
  first.view.unmount();

  const next = await openConsole();
  expect(screen.getByText('C', { selector: 'strong' })).toBeVisible();
  fireEvent.click(next.increase);
  await waitFor(() =>
    expect(screen.getByText('C♯', { selector: 'strong' })).toBeVisible(),
  );
  await act(async () => {
    pending.resolve();
    await pending.promise;
  });

  expect(requestedKeys()).toEqual([1, 1]);
  expect(screen.getByText('C♯', { selector: 'strong' })).toBeVisible();
  expect(
    vi
      .mocked(recordingCoordinator.updatePlaybackAdjustment)
      .mock.calls.map(([value]) => value.keyShift),
  ).toEqual([1]);
});
