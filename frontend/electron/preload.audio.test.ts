import { beforeEach, expect, it, vi } from 'vitest';

const { invoke, handlers, exposed } = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  handlers: new Map<string, (event: unknown, message: unknown) => void>(),
  exposed: { api: undefined as DesktopApi | undefined },
}));
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: DesktopApi) => {
      exposed.api = api;
    },
  },
  ipcRenderer: {
    invoke,
    on: (
      channel: string,
      listener: (event: unknown, message: unknown) => void,
    ) => {
      handlers.set(channel, listener);
    },
    removeListener: (
      channel: string,
      listener: (event: unknown, message: unknown) => void,
    ) => {
      if (handlers.get(channel) === listener) handlers.delete(channel);
    },
  },
  webUtils: {},
}));
beforeEach(() => {
  vi.resetModules();
  invoke.mockClear();
  handlers.clear();
});

it('forwards each waveform request identity and its matching cancellation', async () => {
  await import('./preload');
  const api = exposed.api!;
  await api.waveformPeaks('song', 1, 480, 'song-request');
  await api.recordingPeaks('take', 240, 'take-request');
  await api.cancelWaveform('song-request');
  expect(invoke.mock.calls).toEqual([
    [
      'desktop:waveform-peaks',
      { songId: 'song', revision: 1, bins: 480, requestId: 'song-request' },
    ],
    [
      'desktop:recording-peaks',
      { recordingId: 'take', bins: 240, requestId: 'take-request' },
    ],
    ['desktop:cancel-waveform', 'song-request'],
  ]);
});

it('forwards app-owned window focus and unsubscribes the listener', async () => {
  await import('./preload');
  const api = exposed.api;
  if (!api) throw new Error('Desktop bridge missing');
  const focused = vi.fn();
  const stop = api.onAppFocus(focused);
  handlers.get('desktop:app-focus')?.(undefined, true);
  handlers.get('desktop:app-focus')?.(undefined, false);
  expect(focused.mock.calls).toEqual([[true], [false]]);
  stop();
  expect(handlers.has('desktop:app-focus')).toBe(false);
});

it('normalizes 60 Hz intervals, shares a native stream, and respects each consumer rate', async () => {
  await import('./preload');
  const api = exposed.api;
  expect(api).toBeDefined();
  if (!api) return;
  const fast = vi.fn();
  const slow = vi.fn();
  const stopFast = api.onAudioNotification('GetSpectrum', 1000 / 60, fast);
  const stopSlow = api.onAudioNotification('GetSpectrum', 50, slow);
  expect(invoke).toHaveBeenCalledOnce();
  expect(invoke).toHaveBeenLastCalledWith('services:audio-subscribe', {
    command: 'GetSpectrum',
    intervalMs: 16,
  });
  for (const milliseconds of [100, 116, 132, 148, 164]) {
    handlers.get('services:audio-notification')?.(undefined, {
      command: 'GetSpectrum',
      value: { status: 0, text: 'bands=0.5', observedAt: milliseconds * 1e6 },
    });
  }
  expect(fast).toHaveBeenCalledTimes(5);
  expect(slow).toHaveBeenCalledTimes(2);
  handlers.get('services:audio-notification')?.(undefined, {
    command: 'GetSpectrum',
    value: { status: 0, text: 'bands=0.5', observedAt: 179.9e6 },
  });
  expect(fast).toHaveBeenCalledTimes(6);
  for (let milliseconds = 196; milliseconds < 1100; milliseconds += 16) {
    handlers.get('services:audio-notification')?.(undefined, {
      command: 'GetSpectrum',
      value: { status: 0, text: 'bands=0.5', observedAt: milliseconds * 1e6 },
    });
  }
  expect(slow).toHaveBeenCalledTimes(20);
  stopFast();
  expect(invoke).toHaveBeenLastCalledWith('services:audio-subscribe', {
    command: 'GetSpectrum',
    intervalMs: 50,
  });
  stopSlow();
  expect(invoke).toHaveBeenLastCalledWith('services:audio-subscribe', {
    command: 'GetSpectrum',
    intervalMs: null,
  });
});
