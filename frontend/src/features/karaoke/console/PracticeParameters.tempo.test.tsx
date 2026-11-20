import { tr } from '@neo-ui-kit/react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import '../../../providers/localization';
import { store } from '../../../providers/store';
import {
  clearOperationFailure,
  operationFailures,
} from '../../../shared/errors';
import { useKaraokeControls } from '../useKaraokeControls';
import { PracticeParameters, TempoField } from './PracticeParameters';

const audio = vi.hoisted(() => ({ setPlaybackRate: vi.fn() }));
const recorder = vi.hoisted(() => ({ updatePlaybackAdjustment: vi.fn() }));
vi.mock('../../../services/audioClient', () => ({ audioClient: audio }));
vi.mock('../../../services/recordingCoordinator', () => ({
  recordingCoordinator: recorder,
}));
vi.mock('../../../providers/application', () => ({
  useRoomPlayback: () => null,
}));
vi.mock('../../../providers/notifications', () => ({
  useNotify: () => vi.fn(),
}));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const Console = () => {
  const [speed, setSpeed] = useState(1);
  const rate = useRef(speed);
  rate.current = speed;
  const controls = useKaraokeControls({
    position: useRef(12),
    speed: rate,
    key: useRef(0),
    monitoring: false,
    ready: true,
    microphoneReady: false,
    setPosition: vi.fn(),
    setSpeed,
    setKeyShift: vi.fn(),
    setGains: vi.fn(),
    setMonitoring: vi.fn(),
  });
  return (
    <PracticeParameters
      speed={speed}
      baseBpm={120}
      keyShift={0}
      keyLabel="C"
      range={null}
      locked={false}
      showNotes
      showLyrics
      autoHideConsole={false}
      hasNotes
      hasLyrics
      setShowNotes={controls.setShowNotes}
      setShowLyrics={controls.setShowLyrics}
      setAutoHideConsole={controls.setAutoHideConsole}
      onSpeedChange={controls.changeSpeed}
      onKeyChange={controls.changeKey}
    />
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  store.setLanguage('ru');
  clearOperationFailure('errors.tempo');
  audio.setPlaybackRate.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  clearOperationFailure('errors.tempo');
});

const tempo = () =>
  screen.getByRole('spinbutton', { name: tr('practiceSpeed') });
const enterTempo = (value: number) => {
  fireEvent.change(tempo(), { target: { value: String(value) } });
  fireEvent.blur(tempo());
};

it('shows the applied tempo after a rejected karaoke speed change and permits retry', async () => {
  const failure = {
    code: 'AudioUnavailable',
    message: 'Service unavailable',
    source: 'audio',
  };
  audio.setPlaybackRate.mockRejectedValueOnce(failure);
  const reported = vi.fn();
  const stop = operationFailures.subscribe(reported);
  try {
    render(<Console />);
    enterTempo(150);
    await waitFor(() =>
      expect(reported).toHaveBeenCalledWith({
        operation: 'errors.tempo',
        error: failure,
      }),
    );

    expect(tempo()).toHaveValue(120);
    expect(recorder.updatePlaybackAdjustment).not.toHaveBeenCalled();
    enterTempo(150);
    await waitFor(() => expect(tempo()).toHaveValue(150));
    expect(audio.setPlaybackRate.mock.calls).toEqual([[1.25], [1.25]]);
    expect(recorder.updatePlaybackAdjustment).toHaveBeenCalledExactlyOnceWith({
      sourceSeconds: 12,
      playbackRate: 1.25,
      keyShift: 0,
    });
  } finally {
    stop();
  }
});

it('keeps the acknowledged tempo visible until the speed request succeeds', async () => {
  const pending = deferred<void>();
  audio.setPlaybackRate.mockReturnValueOnce(pending.promise);
  render(<Console />);
  enterTempo(150);
  try {
    expect(audio.setPlaybackRate).toHaveBeenCalledExactlyOnceWith(1.25);
    expect(tempo()).toHaveValue(120);
    expect(recorder.updatePlaybackAdjustment).not.toHaveBeenCalled();
  } finally {
    await act(async () => pending.resolve());
  }
  expect(tempo()).toHaveValue(150);
});

it.each([
  { entered: 150, applied: 150 },
  { entered: 999, applied: 180 },
])(
  'keeps synchronous settings input and its limit ($entered → $applied)',
  ({ entered, applied }) => {
    const SettingsTempo = () => {
      const [speed, setSpeed] = useState(1);
      return (
        <TempoField
          baseBpm={120}
          tempoBpm={Math.round(120 * speed)}
          locked={false}
          onChange={setSpeed}
        />
      );
    };
    render(<SettingsTempo />);
    enterTempo(entered);
    expect(tempo()).toHaveValue(applied);
    expect(audio.setPlaybackRate).not.toHaveBeenCalled();
  },
);
