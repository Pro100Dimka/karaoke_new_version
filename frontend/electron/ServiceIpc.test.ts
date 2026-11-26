import { EventEmitter } from 'node:events';
import type { IpcMainInvokeEvent } from 'electron';
import { expect, it, vi } from 'vitest';
import { registerServiceIpc } from './ServiceIpc';
import { sendAudioRequest } from './AudioServiceTransport';
import { ipcChannels } from './ipcChannels';
import type { TrustedIpc } from './TrustedIpc';

const { subscribe } = vi.hoisted(() => ({ subscribe: vi.fn() }));
const declaration = vi.hoisted(() => vi.fn());
vi.mock('./TransferPermissions', () => ({
  requestFileDeclaration: declaration,
}));
vi.mock('./AudioServiceTransport', () => ({
  subscribeAudioNotifications: subscribe,
  sendAudioRequest: vi.fn(),
}));
vi.mock('./RoomServerTransport', () => ({}));
vi.mock('./SocialIdentity', () => ({}));

it.each([
  '/songs/song/processing',
  '/songs/song/processing/melody',
  '/songs/song/processing/lyrics',
])('requires a file declaration before forwarding remote %s', async (path) => {
  const handlers = new Map<string, Parameters<TrustedIpc['handle']>[1]>();
  const ipc: TrustedIpc = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
    isRendererUrl: () => true,
  };
  const backend = {
    request: vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        body: { processingBackend: 'Oracle' },
      })
      .mockResolvedValueOnce({ ok: true }),
  };
  declaration.mockReset().mockResolvedValue('scoped-ticket');
  registerServiceIpc(
    ipc,
    backend as Parameters<typeof registerServiceIpc>[1],
    {} as Parameters<typeof registerServiceIpc>[2],
    vi.fn(),
  );
  await handlers.get(ipcChannels.pythonRequest)!(
    { sender: new EventEmitter() } as IpcMainInvokeEvent,
    { method: 'POST', path, body: {} },
  );
  expect(declaration).toHaveBeenCalledWith('processing', path);
  expect(backend.request).toHaveBeenLastCalledWith(
    path,
    expect.objectContaining({
      headers: expect.objectContaining({
        'X-AD-Voice-File-Declaration': 'scoped-ticket',
      }),
    }),
  );
});

it('does not forward a remote job after the declaration is declined', async () => {
  const handlers = new Map<string, Parameters<TrustedIpc['handle']>[1]>();
  const ipc: TrustedIpc = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
    isRendererUrl: () => true,
  };
  const backend = {
    request: vi
      .fn()
      .mockResolvedValue({ ok: true, body: { processingBackend: 'Oracle' } }),
  };
  declaration.mockReset().mockRejectedValue(new Error('declined'));
  registerServiceIpc(
    ipc,
    backend as Parameters<typeof registerServiceIpc>[1],
    {} as Parameters<typeof registerServiceIpc>[2],
    vi.fn(),
  );
  await expect(
    handlers.get(ipcChannels.pythonRequest)!(
      { sender: new EventEmitter() } as IpcMainInvokeEvent,
      { method: 'POST', path: '/songs/song/processing', body: {} },
    ),
  ).rejects.toThrow('declined');
  expect(backend.request).toHaveBeenCalledTimes(1);
});

it('keeps audio streams through hash navigation and reports only audio command failures', async () => {
  const handlers = new Map<string, Parameters<TrustedIpc['handle']>[1]>();
  const ipc: TrustedIpc = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
    isRendererUrl: () => true,
  };
  const sender = Object.assign(new EventEmitter(), {
    send: vi.fn(),
    isDestroyed: () => false,
  });
  const event = { sender } as unknown as IpcMainInvokeEvent;
  const stop = vi.fn();
  subscribe.mockReturnValue(stop);
  const audioEvent = vi.fn();
  registerServiceIpc(
    ipc,
    {} as Parameters<typeof registerServiceIpc>[1],
    {} as Parameters<typeof registerServiceIpc>[2],
    audioEvent,
  );
  const listen = () =>
    handlers.get(ipcChannels.audioSubscribe)!(event, {
      command: 'GetSpectrum',
      intervalMs: 50,
    });
  listen();
  sender.emit('did-start-loading');
  sender.emit('did-start-navigation', {
    isMainFrame: false,
    isSameDocument: false,
  });
  sender.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: true,
  });
  expect(stop).not.toHaveBeenCalled();
  sender.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false,
  });
  expect(stop).toHaveBeenCalledTimes(1);
  listen();
  sender.emit('destroyed');
  expect(stop).toHaveBeenCalledTimes(2);
  const request = handlers.get(ipcChannels.audioRequest)!;
  vi.mocked(sendAudioRequest).mockResolvedValueOnce({
    status: 1,
    text: 'output failed',
  });
  await request(event, { command: 'Play' });
  expect(audioEvent).toHaveBeenLastCalledWith('command-failed:Play');
  audioEvent.mockClear();
  vi.mocked(sendAudioRequest).mockResolvedValueOnce({
    status: 0,
    text: 'Playing',
  });
  await request(event, { command: 'Play' });
  expect(audioEvent).not.toHaveBeenCalled();
});

it('releases audio notification streams when a renderer crashes before a reload begins', () => {
  const handlers = new Map<string, Parameters<TrustedIpc['handle']>[1]>();
  const ipc: TrustedIpc = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
    isRendererUrl: () => true,
  };
  const sender = Object.assign(new EventEmitter(), {
    send: vi.fn(),
    isDestroyed: () => false,
  });
  const event = { sender } as unknown as IpcMainInvokeEvent;
  const stopSpectrum = vi.fn();
  const stopPlayback = vi.fn();
  subscribe.mockReturnValueOnce(stopSpectrum).mockReturnValueOnce(stopPlayback);
  registerServiceIpc(
    ipc,
    {} as Parameters<typeof registerServiceIpc>[1],
    {} as Parameters<typeof registerServiceIpc>[2],
  );
  const listen = handlers.get(ipcChannels.audioSubscribe)!;
  listen(event, { command: 'GetSpectrum', intervalMs: 50 });
  listen(event, { command: 'GetPlaybackSnapshot', intervalMs: 16 });

  sender.emit('render-process-gone', {}, { reason: 'crashed' });
  expect(stopSpectrum).toHaveBeenCalledOnce();
  expect(stopPlayback).toHaveBeenCalledOnce();

  const stopReplacement = vi.fn();
  subscribe.mockReturnValueOnce(stopReplacement);
  listen(event, { command: 'GetSpectrum', intervalMs: 50 });
  sender.emit('destroyed');
  expect(stopReplacement).toHaveBeenCalledOnce();
  expect(stopSpectrum).toHaveBeenCalledOnce();
  expect(stopPlayback).toHaveBeenCalledOnce();
});
