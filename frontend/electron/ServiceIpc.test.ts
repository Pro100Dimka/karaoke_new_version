import { EventEmitter } from 'node:events';
import type { IpcMainInvokeEvent } from 'electron';
import { expect, it, vi } from 'vitest';
import { registerServiceIpc } from './ServiceIpc';
import { ipcChannels } from './ipcChannels';
import type { TrustedIpc } from './TrustedIpc';

const { subscribe } = vi.hoisted(() => ({ subscribe: vi.fn() }));
vi.mock('./AudioServiceTransport', () => ({
  subscribeAudioNotifications: subscribe,
  sendAudioRequest: vi.fn(),
}));
vi.mock('./RoomServerTransport', () => ({}));
vi.mock('./SocialIdentity', () => ({}));

it('keeps audio streams through iframe loads and hash navigation, but releases them on renderer replacement', () => {
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
  registerServiceIpc(
    ipc,
    {} as Parameters<typeof registerServiceIpc>[1],
    {} as Parameters<typeof registerServiceIpc>[2],
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
});
