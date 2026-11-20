import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { RequestedAudioConfiguration } from '../../contracts/models';
import { useKaraokeSession } from './useKaraokeSession';
import { audioClient } from '../../services/audioClient';
import { recordingCoordinator } from '../../services/recordingCoordinator';
import { usePositionPolling } from './usePositionPolling';
import { useAudioRecovery } from './useAudioRecovery';

const native = vi.hoisted(() => ({
  microphone: 'missing' as 'missing' | 'ready',
}));
const services = vi.hoisted(() => ({ pythonEpoch: 0, audioEpoch: 0 }));
const preferences = vi.hoisted(() => ({
  audio: {
    backend: 'WASAPI Shared',
    sampleRate: 0,
    periodFrames: 0,
  } as RequestedAudioConfiguration,
  musicGain: 1,
  voiceGain: 1,
  referenceGain: 0,
  melodyGain: 0,
  masterGain: 1,
  karaokeMonitoring: false,
  keyboardLighting: false,
  theme: 'dark',
}));
vi.mock('../../providers/store', () => ({
  store: {
    application: { services },
    online: { room: null },
    preferences,
    updatePreferences: vi.fn(),
    cancelPlaylist: vi.fn(),
  },
}));
vi.mock('../../providers/application', () => ({ useRoomPlayback: () => null }));
vi.mock('../../providers/notifications', () => ({ useNotify: () => vi.fn() }));
vi.mock('../../providers/dialog', () => ({ ask: vi.fn() }));
vi.mock('../../providers/close-guards', () => ({ useCloseGuard: vi.fn() }));
vi.mock('../../pages/library/modals/settings', () => ({
  openSettings: vi.fn(),
}));
vi.mock('../../pages/editor/editorApi', () => ({
  editorApi: { load: vi.fn(async () => null) },
}));
vi.mock('../../application/karaoke/karaokeLoader', () => ({
  resolveKaraokeLoad: vi.fn(async () => ({
    load: { kind: 'ready', song: { id: 'song', activeRevision: 1 } },
    prefs: { language: 'Auto' },
  })),
}));
vi.mock('../../services/pythonClient', () => ({
  pythonClient: { freeStorageBytes: vi.fn(async () => 1e9) },
}));
vi.mock('../../services/audioClient', () => ({
  audioClient: {
    capabilities: vi.fn(async () => ({
      microphone: native.microphone,
      keyboardLighting: false,
    })),
    prepareSong: vi.fn(async () => ({})),
    setPlaybackRate: vi.fn(async () => undefined),
    setPitchShift: vi.fn(async () => undefined),
    setMixer: vi.fn(async () => undefined),
    setDspEnabled: vi.fn(async () => undefined),
    setMonitoring: vi.fn(async (enabled: boolean) => ({ monitoring: enabled })),
    play: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  },
}));
vi.mock('../../services/recordingCoordinator', () => ({
  recordingCoordinator: {
    start: vi.fn(async () => ({ recording: true })),
    stop: vi.fn(async () => ({ recording: false })),
    pause: vi.fn(async () => ({ recording: true })),
    resume: vi.fn(async () => ({ recording: true })),
    elapsedSeconds: () => 0,
    hasPendingTake: () => false,
    observePosition: vi.fn(),
    observeMicrophoneActivity: vi.fn(),
    updatePlaybackAdjustment: vi.fn(),
    interrupt: vi.fn(),
  },
}));
vi.mock('./usePositionPolling', () => ({
  usePositionPolling: vi.fn(() => ({ invalidate: vi.fn() })),
}));
vi.mock('./useAudioRecovery', () => ({ useAudioRecovery: vi.fn() }));
vi.mock('./useKeyboardLighting', () => ({ useKeyboardLighting: vi.fn() }));
vi.mock('./useSynchronizedRoomPlayback', () => ({
  useSynchronizedRoomPlayback: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  native.microphone = 'missing';
  vi.mocked(audioClient.capabilities)
    .mockReset()
    .mockImplementation(async () => ({
      microphone: native.microphone,
      keyboardLighting: false,
    }));
  services.pythonEpoch = services.audioEpoch = 0;
  preferences.audio = {
    backend: 'WASAPI Shared',
    sampleRate: 0,
    periodFrames: 0,
  };
  preferences.karaokeMonitoring = false;
});

const openSession = async () => {
  const hook = renderHook(() => useKaraokeSession('song', 'Normal', true));
  await waitFor(() => expect(hook.result.current.state.kind).toBe('ready'));
  return hook;
};

it.each(['device recovery', 'device selection'] as const)(
  'records and monitors a microphone added through %s without reopening the song',
  async (change) => {
    const { result, rerender } = await openSession();
    native.microphone = 'ready';
    if (change === 'device recovery') services.audioEpoch++;
    else
      preferences.audio = {
        ...preferences.audio,
        inputDeviceId: 'new-microphone',
      };
    rerender();
    await waitFor(() =>
      expect(result.current.capabilities.microphone).toBe('ready'),
    );

    await act(() => result.current.toggleMonitoring());
    await act(() => result.current.togglePlay());

    expect(audioClient.setMonitoring).toHaveBeenCalledWith(true);
    expect(recordingCoordinator.start).toHaveBeenCalledOnce();
    expect(result.current.recording).toBe('recording');
    expect(audioClient.prepareSong).toHaveBeenCalledOnce();
    expect(audioClient.setPlaybackRate).toHaveBeenCalledOnce();
    expect(audioClient.setPitchShift).toHaveBeenCalledOnce();
  },
);

it('stops advertising a microphone after its removal', async () => {
  native.microphone = 'ready';
  const { result, rerender } = await openSession();
  native.microphone = 'missing';
  services.audioEpoch++;
  rerender();
  await waitFor(() =>
    expect(result.current.capabilities.microphone).toBe('missing'),
  );
  await act(() => result.current.toggleMonitoring());
  await act(() => result.current.togglePlay());
  expect(audioClient.setMonitoring).not.toHaveBeenCalled();
  expect(recordingCoordinator.start).not.toHaveBeenCalled();
  expect(result.current.state.kind).toBe('playing');
});

it('starts capturing when a microphone returns during playback', async () => {
  const { result, rerender } = await openSession();
  await act(() => result.current.togglePlay());
  expect(recordingCoordinator.start).not.toHaveBeenCalled();
  native.microphone = 'ready';
  services.audioEpoch++;
  rerender();
  await waitFor(() => expect(result.current.recording).toBe('recording'));
  expect(recordingCoordinator.start).toHaveBeenCalledOnce();
  expect(audioClient.play).toHaveBeenCalledOnce();
});

it('refreshes microphone readiness before resuming after audio recovery', async () => {
  const { result } = await openSession();
  await act(() => result.current.togglePlay());
  native.microphone = 'ready';
  act(() => vi.mocked(usePositionPolling).mock.calls.at(-1)?.[0].onLost());
  expect(result.current.state.kind).toBe('recovering');
  act(() => vi.mocked(useAudioRecovery).mock.calls.at(-1)?.[0].onRecovered());
  await waitFor(() => expect(result.current.state.kind).toBe('playing'));
  expect(recordingCoordinator.start).toHaveBeenCalledOnce();
  expect(result.current.recording).toBe('recording');
});

it('restores requested monitoring when the microphone returns but not after a safety trip', async () => {
  preferences.karaokeMonitoring = true;
  const { result, rerender } = await openSession();
  expect(audioClient.setMonitoring).not.toHaveBeenCalled();
  native.microphone = 'ready';
  services.audioEpoch++;
  rerender();
  await waitFor(() =>
    expect(audioClient.setMonitoring).toHaveBeenCalledWith(true),
  );
  await act(async () => {
    vi.mocked(usePositionPolling).mock.calls.at(-1)?.[0].onSnapshot?.({
      sessionId: 'session',
      state: 'ready',
      positionSeconds: 0,
      durationSeconds: 60,
      inputLevel: 0,
      monitoring: false,
      monitoringSafetyTripped: true,
    });
  });
  expect(result.current.monitoring).toBe(false);
  expect(audioClient.setMonitoring).toHaveBeenCalledOnce();
});

it('does not let an old device capability reply replace the current microphone state', async () => {
  const { result, rerender } = await openSession();
  let finishOld!: () => void;
  vi.mocked(audioClient.capabilities).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishOld = () =>
          resolve({ microphone: 'missing', keyboardLighting: false });
      }),
  );
  services.audioEpoch++;
  rerender();
  await waitFor(() =>
    expect(audioClient.capabilities).toHaveBeenCalledTimes(2),
  );
  native.microphone = 'ready';
  services.audioEpoch++;
  rerender();
  await waitFor(() =>
    expect(result.current.capabilities.microphone).toBe('ready'),
  );
  await act(async () => finishOld());
  expect(result.current.capabilities.microphone).toBe('ready');
});
