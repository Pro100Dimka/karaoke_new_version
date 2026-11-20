import { vi } from 'vitest';
import type { RoomStateDto, SongDto } from '../src/contracts/models';
import type { RoomSessionScope } from '../src/application/room/RoomSessionController';
import { RoomProjectCoordinator } from '../src/application/room/RoomProjectCoordinator';

export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
export const setup = () => {
  let active = true;
  let room: RoomStateDto = {
    code: 'room-a',
    hostId: 'host',
    role: 'participant',
    participants: [],
    playbackLocked: false,
  };
  let progress: (value: {
    transferId: string;
    direction: 'upload' | 'download';
    transferredBytes: number;
    totalBytes: number;
  }) => void = () => undefined;
  const scope: RoomSessionScope = {
    code: 'room-a',
    generation: 1,
    signal: new AbortController().signal,
    isCurrent: () => active,
    getRoom: () => (active ? room : null),
    setSnapshot: (snapshot) => {
      if (!active) return false;
      room = snapshot;
      return true;
    },
    disconnect: () => {
      active = false;
      return true;
    },
  };
  const services = {
    room: {
      setRoomReadiness: vi.fn(async () => room),
      publishLibrary: vi.fn(async () => room),
    },
    python: {
      importProject: vi.fn(async () => ({ id: 'local-song' }) as SongDto),
      listSongs: vi.fn(async (): Promise<readonly SongDto[]> => []),
      exportProject: vi.fn(async () => 'archive.zip'),
    },
    desktop: {
      downloadRoomProject: vi.fn(async () => 'archive.zip'),
      cancelRoomProjectTransfer: vi.fn(async () => undefined),
      releaseRoomProjectDownload: vi.fn(async () => undefined),
      uploadRoomProject: vi.fn(
        async (
          _request: RoomProjectTransferRequest & { path: string },
        ): Promise<void> => undefined,
      ),
      onRoomProjectTransferProgress: vi.fn((listener) => {
        progress = listener;
        return () => {
          progress = () => undefined;
        };
      }),
    },
    copies: { get: vi.fn(), remember: vi.fn() },
    participantId: 'self',
    onFailure: vi.fn(),
  };
  return {
    scope,
    services,
    coordinator: new RoomProjectCoordinator(scope, services),
    leave: () => {
      active = false;
    },
    getRoom: () => room,
    setRoom: (value: RoomStateDto) => {
      room = value;
    },
    progress: (value: {
      transferId: string;
      direction: 'upload' | 'download';
      transferredBytes: number;
      totalBytes: number;
    }) => progress(value),
  };
};
