import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { RequestedAudioConfiguration } from '../../../../../contracts/models';
import { audioClient } from '../../../../../services/audioClient';
import { store } from '../../../../../providers/store';
import { useAudioSettings } from './useAudioSettings';

const runtime = vi.hoisted(() => ({
  backend: 'WASAPI Shared',
  sampleRate: 48000,
  periodFrames: 480,
  endpointBufferFrames: 960,
  defaultPeriodFrames: 480,
  estimatedLatencyMs: 20,
  inputDeviceId: 'current-microphone',
  outputDeviceId: 'current-headphones',
}));
vi.mock('../../../../../providers/store', () => ({
  store: {
    preferences: {
      audio: { backend: 'WASAPI Shared', sampleRate: 0, periodFrames: 0 },
      releaseAsioInBackground: false,
    },
    updatePreferences: vi.fn(),
  },
}));
vi.mock('../../../../../providers/notifications', () => ({
  useNotify: () => vi.fn(),
}));
vi.mock('../../../../../services/audioClient', () => ({
  audioClient: {
    runtimeConfiguration: vi.fn(async () => runtime),
    listDevices: vi.fn(async () => [
      {
        id: runtime.inputDeviceId,
        kind: 'input',
        name: 'Microphone',
        backend: runtime.backend,
        channels: 2,
      },
      {
        id: runtime.outputDeviceId,
        kind: 'output',
        name: 'Headphones',
        backend: runtime.backend,
        channels: 2,
      },
    ]),
    capabilities: vi.fn(async () => ({
      microphone: 'ready',
      keyboardLighting: false,
    })),
    configurationCapabilities: vi.fn(async () => ({
      sampleRates: [44100, 48000],
      periodFrames: [128, 480],
      defaultSampleRate: 48000,
      defaultPeriodFrames: 480,
    })),
    applyConfiguration: vi.fn(async () => runtime),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  store.preferences.audio = {
    backend: 'WASAPI Shared',
    sampleRate: 0,
    periodFrames: 0,
  };
});

it.each([
  ['periodFrames', 128],
  ['sampleRate', 44100],
] as const)(
  'keeps System Default endpoints when changing only %s',
  async (name, value) => {
    const { result } = renderHook(() => useAudioSettings());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.audio.runtime.inputDeviceId).toBe(
      'current-microphone',
    );
    expect(result.current.audio.runtime.outputDeviceId).toBe(
      'current-headphones',
    );

    act(() => result.current.audio.onAudioCommit(name, value));

    await waitFor(() => expect(store.updatePreferences).toHaveBeenCalledOnce());
    const applied = vi.mocked(audioClient.applyConfiguration).mock
      .calls[0]?.[0];
    expect(applied).toMatchObject({ [name]: value });
    expect(applied?.inputDeviceId).toBeUndefined();
    expect(applied?.outputDeviceId).toBeUndefined();
    expect(store.updatePreferences).toHaveBeenCalledWith({ audio: applied });
  },
);

it('changes only the selected endpoint when returning the output to System Default', async () => {
  const requested: RequestedAudioConfiguration = {
    backend: 'WASAPI Shared',
    sampleRate: 48000,
    periodFrames: 480,
    inputDeviceId: 'chosen-microphone',
    outputDeviceId: 'chosen-headphones',
  };
  store.preferences.audio = requested;
  const { result } = renderHook(() => useAudioSettings());
  await waitFor(() => expect(result.current.ready).toBe(true));

  act(() => result.current.audio.onAudioCommit('outputDeviceId', ''));

  await waitFor(() =>
    expect(audioClient.applyConfiguration).toHaveBeenCalledOnce(),
  );
  expect(audioClient.applyConfiguration).toHaveBeenCalledWith(
    expect.objectContaining({
      inputDeviceId: 'chosen-microphone',
      outputDeviceId: undefined,
      sampleRate: 0,
      periodFrames: 0,
    }),
  );
});
