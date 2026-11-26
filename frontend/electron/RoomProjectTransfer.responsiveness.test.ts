import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';
import { registerRoomProjectTransferHandlers } from './RoomProjectTransfer';
import { ipcChannels } from './ipcChannels';
import { transferConsentChanges } from './PrivacySettings';
vi.mock('./TransferPermissions', () => ({
  requestFileDeclaration: async () => 'scoped-file-ticket',
}));

const io = vi.hoisted(() => ({
  realpath: vi.fn(),
  realpathSync: vi.fn((value: string) => value),
}));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  const mocked = { ...actual, realpathSync: io.realpathSync };
  return { ...mocked, default: mocked };
});
vi.mock('node:fs/promises', async (original) => {
  const mocked = {
    ...(await original<typeof import('node:fs/promises')>()),
    realpath: io.realpath,
  };
  return { ...mocked, default: mocked };
});
vi.mock('./RoomIdentity', () => ({
  withRoomKey: async (headers: Record<string, string>) => headers,
}));

afterEach(() => {
  transferConsentChanges.removeAllListeners('withdraw');
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('keeps the main thread available during path validation and honors cancellation before uploading', async () => {
  let release!: () => void;
  const disk = new Promise<void>((resolve) => {
    release = resolve;
  });
  io.realpath.mockImplementation(async (value: string) => {
    await disk;
    return value;
  });
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
  >();
  registerRoomProjectTransferHandlers('https://example.org', () => '/backend', {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
  });
  const sender = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: vi.fn(),
  });
  const event = { sender } as unknown as IpcMainInvokeEvent;
  const operation = Promise.resolve(
    handlers.get(ipcChannels.uploadRoomProject)!(event, {
      roomId: 'room',
      participantId: 'guest',
      songId: 'song',
      revision: 1,
      path: '/backend/project.zip',
      transferId: 'slow-path',
    }),
  ).catch((error: unknown) => error);
  try {
    await setImmediate();
    expect(io.realpathSync).not.toHaveBeenCalled();
    expect(io.realpath).toHaveBeenCalledWith('/backend/project.zip');
    expect(io.realpath).toHaveBeenCalledWith('/backend');
    expect(fetch).not.toHaveBeenCalled();
    await handlers.get(ipcChannels.cancelRoomProjectTransfer)!(
      event,
      'slow-path',
    );
  } finally {
    release();
  }
  expect(await operation).toMatchObject({ name: 'AbortError' });
  expect(fetch).not.toHaveBeenCalled();
});
