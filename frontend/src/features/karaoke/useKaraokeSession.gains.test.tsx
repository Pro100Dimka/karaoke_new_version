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
import { MasterVolume } from './console/MasterVolume';
import { audioClient } from '../../services/audioClient';
import { store } from '../../providers/store';
import { masterGainMax } from '../../shared/preferences/preferences';
import { volumeFromKnob } from '../../shared/utils/mixerLevel';
import { clearOperationFailure } from '../../shared/errors';

let session: ReturnType<typeof useKaraokeSession>;
const save = vi.fn();

const Mixer = () => {
  session = useKaraokeSession('song', 'Normal', true);
  return (
    <MasterVolume
      value={session.gains.master}
      onChange={(value) => void session.changeGain('master', value)}
    />
  );
};

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  vi.clearAllMocks();
  clearOperationFailure('errors.mixer');
  karaokeRecordingFixtureState.roomState.room = null;
  karaokeRecordingFixtureState.roomState.playbackEnabled = false;
  vi.mocked(audioClient.setMixer).mockReset().mockResolvedValue(undefined);
  // The shared session fixture exposes its preference writer through a getter.
  vi.spyOn(
    store as { updatePreferences: unknown },
    'updatePreferences',
    'get',
  ).mockReturnValue(save);
});
afterEach(() => vi.restoreAllMocks());

const openMixer = async () => {
  const view = render(<Mixer />);
  await waitFor(() => expect(session.state.kind).toBe('ready'));
  // The ready session first restores all five accepted channel gains.
  await waitFor(() => expect(audioClient.setMixer).toHaveBeenCalledTimes(5));
  vi.mocked(audioClient.setMixer).mockClear();
  return {
    view,
    knob: screen.getByRole('slider', { name: tr('masterVolume') }),
  };
};

it('moves the actual controlled knob immediately and accumulates keyboard steps while native gain is pending', async () => {
  const { knob } = await openMixer();
  const pending = deferred();
  vi.mocked(audioClient.setMixer).mockImplementation(() => pending.promise);

  fireEvent.keyDown(knob, { key: 'Home' });
  expect(knob).toHaveAttribute('aria-valuenow', '0');
  fireEvent.keyDown(knob, { key: 'ArrowUp' });
  expect(knob).toHaveAttribute('aria-valuenow', '0.01');
  fireEvent.keyDown(knob, { key: 'ArrowUp' });
  expect(knob).toHaveAttribute('aria-valuenow', '0.02');
  const firstStep = volumeFromKnob(0.01, masterGainMax);
  const finalStep = volumeFromKnob(0.02, masterGainMax);
  expect(vi.mocked(audioClient.setMixer).mock.calls).toEqual([
    ['master', 0],
    ['master', firstStep],
    ['master', finalStep],
  ]);
  expect(save).not.toHaveBeenCalled();

  // The native queue can acknowledge several merged callers together.
  await act(async () => pending.resolve());
  expect(knob).toHaveAttribute('aria-valuenow', '0.02');
  expect(session.gains.master).toBe(finalStep);
  expect(save).toHaveBeenLastCalledWith({ masterGain: finalStep });
});

it('keeps a newer gesture visible through an older acknowledgement and rolls a failed newest gesture back to the accepted gain', async () => {
  const { knob } = await openMixer();
  const first = deferred();
  const latest = deferred();
  vi.mocked(audioClient.setMixer)
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => latest.promise);
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  fireEvent.keyDown(knob, { key: 'Home' });
  fireEvent.keyDown(knob, { key: 'ArrowUp' });
  expect(knob).toHaveAttribute('aria-valuenow', '0.01');
  await act(async () => first.resolve());
  expect(knob).toHaveAttribute('aria-valuenow', '0.01');
  expect(save).toHaveBeenCalledExactlyOnceWith({ masterGain: 0 });

  await act(async () => latest.reject(new Error('Gain unavailable')));
  expect(knob).toHaveAttribute('aria-valuenow', '0');
  expect(session.gains.master).toBe(0);
  expect(save).toHaveBeenCalledTimes(1);
  expect(errors).toHaveBeenCalledWith('errors.mixer', expect.any(Error));
});

it('retains the newer pending gesture when the older command fails and only saves an accepted gain', async () => {
  const { knob } = await openMixer();
  const first = deferred();
  const latest = deferred();
  vi.mocked(audioClient.setMixer)
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => latest.promise);
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  fireEvent.keyDown(knob, { key: 'Home' });
  fireEvent.keyDown(knob, { key: 'ArrowUp' });
  await act(async () => first.reject(new Error('Gain unavailable')));
  expect(knob).toHaveAttribute('aria-valuenow', '0.01');
  expect(save).not.toHaveBeenCalled();
  expect(errors).toHaveBeenCalledWith('errors.mixer', expect.any(Error));

  await act(async () => latest.resolve());
  expect(knob).toHaveAttribute('aria-valuenow', '0.01');
  expect(save).toHaveBeenCalledExactlyOnceWith({
    masterGain: volumeFromKnob(0.01, masterGainMax),
  });
});

it('resolves pending gains independently for different mixer channels', async () => {
  await openMixer();
  const music = deferred();
  const master = deferred();
  vi.mocked(audioClient.setMixer)
    .mockImplementationOnce(() => music.promise)
    .mockImplementationOnce(() => master.promise);
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  act(() => {
    void session.changeGain('music', 0.3);
    void session.changeGain('master', 0.8);
  });
  expect(session.gains).toMatchObject({ music: 0.3, master: 0.8 });
  await act(async () => music.resolve());
  expect(session.gains).toMatchObject({ music: 0.3, master: 0.8 });
  expect(save).toHaveBeenCalledExactlyOnceWith({ musicGain: 0.3 });

  await act(async () => master.reject(new Error('Master unavailable')));
  expect(session.gains).toMatchObject({ music: 0.3, master: 0.86 });
  expect(save).toHaveBeenCalledTimes(1);
  expect(errors).toHaveBeenCalledWith('errors.mixer', expect.any(Error));
});
