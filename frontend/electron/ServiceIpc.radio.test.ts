import { EventEmitter } from 'node:events';
import type { IpcMainInvokeEvent } from 'electron';
import { expect, it, vi } from 'vitest';
import { registerServiceIpc } from './ServiceIpc';
import { ipcChannels } from './ipcChannels';
import type { TrustedIpc } from './TrustedIpc';

vi.mock('./AudioServiceTransport', () => ({
  subscribeAudioNotifications: vi.fn(),
  sendAudioRequest: vi.fn(async () => ({ status: 0, text: '' })),
}));
vi.mock('./RoomServerTransport', () => ({}));
vi.mock('./SocialIdentity', () => ({}));

const setup = () => {
  const handlers = new Map<string, Parameters<TrustedIpc['handle']>[1]>();
  const ipc: TrustedIpc = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
    isRendererUrl: () => true,
  };
  const calls: { signal?: AbortSignal; finish(): void }[] = [];
  const backend = {
    request: vi.fn(
      (_path: string, options: RequestInit) =>
        new Promise((resolve, reject) => {
          calls.push({
            signal: options.signal ?? undefined,
            finish: () => resolve({ status: 200, ok: true, body: {} }),
          });
          options.signal?.addEventListener(
            'abort',
            () => reject(options.signal!.reason),
            { once: true },
          );
        }),
    ),
  };
  registerServiceIpc(
    ipc,
    backend as unknown as Parameters<typeof registerServiceIpc>[1],
    null,
  );
  const makeEvent = () =>
    ({
      sender: Object.assign(new EventEmitter(), {
        isDestroyed: () => false,
        send: vi.fn(),
      }),
    }) as unknown as IpcMainInvokeEvent;
  const request = (
    event: IpcMainInvokeEvent,
    path = '/radio/youtube?playlist_id=PL1234567890&index=1',
  ) =>
    Promise.resolve(
      handlers.get(ipcChannels.pythonRequest)!(event, { method: 'GET', path }),
    );
  return { handlers, calls, makeEvent, request };
};

it('cancels only the replaced YouTube lookup from the same window', async () => {
  const { calls, makeEvent, request } = setup();
  const firstWindow = makeEvent();
  const otherWindow = makeEvent();
  const pending = [
    request(firstWindow),
    request(otherWindow),
    request(firstWindow, '/songs'),
    request(firstWindow),
  ];
  try {
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(calls[1]?.signal?.aborted).toBe(false);
    expect(calls[2]?.signal?.aborted).not.toBe(true);
    expect(calls[3]?.signal?.aborted).toBe(false);
    await pending[0];
    // Cleanup of the cancelled lookup must not forget its replacement.
    pending.push(request(firstWindow));
    expect(calls[3]?.signal?.aborted).toBe(true);
    expect(calls[4]?.signal?.aborted).toBe(false);
  } finally {
    calls.forEach((call) => call.finish());
    await Promise.all(pending);
  }
});

it.each([
  'StopRadio',
  'destroyed',
  'render-process-gone',
  'did-start-navigation',
])('releases pending YouTube work on %s', async (reason) => {
  const { calls, handlers, makeEvent, request } = setup();
  const event = makeEvent();
  const pending = request(event);
  try {
    event.sender.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: true,
    });
    event.sender.emit('did-start-navigation', {
      isMainFrame: false,
      isSameDocument: false,
    });
    expect(calls[0]?.signal?.aborted).toBe(false);
    if (reason === 'StopRadio')
      await handlers.get(ipcChannels.audioRequest)!(event, {
        command: 'StopRadio',
      });
    else
      event.sender.emit(reason, { isMainFrame: true, isSameDocument: false });
    expect(calls[0]?.signal?.aborted).toBe(true);
  } finally {
    calls.forEach((call) => call.finish());
    await pending;
  }
});
