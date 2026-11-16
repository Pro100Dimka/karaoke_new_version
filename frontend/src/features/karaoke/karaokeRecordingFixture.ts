import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, vi } from 'vitest';
import { useKaraokeSession } from './useKaraokeSession';
import { pythonClient } from '../../services/pythonClient';
import type { RoomStateDto } from '../../contracts/models';
const dialogs = vi.hoisted(() => ({ ask: vi.fn() }));
const roomState = vi.hoisted(() => ({
  room: null as RoomStateDto | null,
  playbackEnabled: false,
  playback: { reportReady: vi.fn(async () => undefined) },
}));
const monitoringPreference = vi.hoisted(() => ({
  enabled: false,
  microphoneReady: true,
}));
const monitoringWarning = vi.hoisted(() => vi.fn());
vi.mock('../../providers/application', () => ({
  useRoomPlayback: () =>
    roomState.playbackEnabled ? roomState.playback : null,
  useApp: () => ({
    room: roomState.room,
    preferences: {
      musicGain: 0.42,
      voiceGain: 0.53,
      referenceGain: 0.64,
      melodyGain: 0.75,
      masterGain: 0.86,
      karaokeMonitoring: monitoringPreference.enabled,
      keyboardLighting: false,
      theme: 'dark',
    },
    updatePreferences: vi.fn(),
    openSettings: vi.fn(),
  }),
}));
vi.mock('../../providers/dialog', () => ({ ask: dialogs.ask }));
vi.mock('../../providers/close-guards', () => ({ useCloseGuard: vi.fn() }));
vi.mock('../../providers/notifications', () => ({
  useNotify: () => monitoringWarning,
}));
vi.mock('../../services/pythonClient', () => ({
  pythonClient: { freeStorageBytes: vi.fn() },
}));
vi.mock('../../services/audioClient', () => ({
  audioClient: {
    play: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    setMonitoring: vi.fn(async (enabled: boolean) => ({ monitoring: enabled })),
    setDspEnabled: vi.fn(async () => undefined),
    setMixer: vi.fn(async () => undefined),
  },
}));
vi.mock('../../services/recordingCoordinator', () => ({
  recordingCoordinator: {
    elapsedSeconds: () => 0,
    start: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(async () => ({ recording: true })),
    resume: vi.fn(async () => ({ recording: true })),
    observePosition: vi.fn(),
    interrupt: vi.fn(),
    hasPendingTake: () => true,
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
vi.mock('./useKaraokeLoadSession', async () => {
  const { useEffect } = await import('react');
  const song = { id: 'song', activeRevision: 1 };
  return {
    useKaraokeLoadSession: (
      _id: string,
      _mode: string,
      _gains: unknown,
      prepared: () => void,
    ) => {
      useEffect(() => {
        prepared();
      }, []);
      return {
        load: { kind: 'ready', song },
        capabilities: {
          microphone: monitoringPreference.microphoneReady
            ? 'ready'
            : 'missing',
        },
      };
    },
  };
});
const startSession = async () => {
  const hook = renderHook(() => useKaraokeSession('song', 'Normal', true));
  await waitFor(() => expect(hook.result.current.state.kind).toBe('ready'));
  act(() => {
    void hook.result.current.togglePlay();
  });
  await waitFor(() => expect(pythonClient.freeStorageBytes).toHaveBeenCalled());
  return hook;
};
vi.mock('../../providers/store', () => ({
  store: {
    cancelPlaylist: vi.fn(),
    get online() {
      return { room: roomState.room };
    },
    get preferences() {
      return {
        musicGain: 0.42,
        voiceGain: 0.53,
        referenceGain: 0.64,
        melodyGain: 0.75,
        masterGain: 0.86,
        karaokeMonitoring: monitoringPreference.enabled,
        keyboardLighting: false,
        theme: 'dark',
      };
    },
    get updatePreferences() {
      return vi.fn();
    },
    get openSettings() {
      return vi.fn();
    },
  },
}));
export { startSession };

export const karaokeRecordingFixtureState = {
  dialogs,
  roomState,
  monitoringPreference,
  monitoringWarning,
};
