import { expect, it, vi } from 'vitest';
import type { RoomStateDto, SongDto } from '../../contracts/models';
import type { RoomClient } from '../../contracts/clients';
import {
  RoomSessionController,
  type RoomSessionScope,
} from './RoomSessionController';
import { RoomRecoveryCoordinator } from './RoomRecoveryCoordinator';
import { roomTransferFailure } from './roomProjectDownload';

const snapshot = (): RoomStateDto => ({
  code: 'room-a',
  hostId: 'host',
  role: 'participant',
  playbackLocked: false,
  participants: [
    {
      id: 'self',
      name: 'Self',
      role: 'participant',
      self: true,
      connected: true,
      readiness: 'ready',
      muted: false,
      volume: 1,
    },
  ],
});

it.each([
  'before delivery',
  'during voice synchronization',
  'during library read',
] as const)(
  'ignores watch side effects when the snapshot becomes stale %s',
  async (staleWhen) => {
    const versioned = (
      snapshotRevision: number,
      songId: string,
    ): RoomStateDto => ({
      ...snapshot(),
      snapshotRevision,
      songId,
      revision: 1,
    });
    const session = new RoomSessionController(
      {
        createRoom: vi.fn(async () => snapshot()),
        joinRoom: vi.fn(async () => snapshot()),
        leaveRoom: vi.fn(async () => undefined),
        closeRoom: vi.fn(async () => undefined),
      },
      {
        joinVoiceSession: vi.fn(async () => undefined),
        setRoomPlayoutDelay: vi.fn(async () => undefined),
        leaveVoiceSession: vi.fn(async () => undefined),
      },
      'self',
    );
    session.setSnapshot(
      staleWhen === 'before delivery'
        ? versioned(3, 'new-song')
        : versioned(1, 'old-song'),
    );
    let deliver!: (room: RoomStateDto) => void;
    let complete!: () => void;
    const pendingVoice = new Promise<void>((resolve) => {
      complete = resolve;
    });
    let completeLibrary!: (songs: readonly SongDto[]) => void;
    const pendingLibrary = new Promise<readonly SongDto[]>((resolve) => {
      completeLibrary = resolve;
    });
    const ports = {
      room: {
        watchRoom: vi.fn<RoomClient['watchRoom']>((_code, onRoom) => {
          deliver = onRoom;
          return vi.fn();
        }),
      },
      audio: { leaveVoiceSession: vi.fn(async () => undefined) },
      python: { listSongs: vi.fn(() => pendingLibrary) },
      voice: {
        synchronize: vi.fn(
          (
            _before: RoomStateDto,
            _after: RoomStateDto,
            _isCurrent?: () => boolean,
          ) => pendingVoice,
        ),
      },
      project: { reconcileReadiness: vi.fn(async () => undefined) },
      launch: {
        selectionChanged: vi.fn(),
        recordPlaybackTransition: vi.fn(),
        observe: vi.fn(),
        stop: vi.fn(),
      },
      notify: vi.fn(),
      chime: vi.fn(),
    };
    const recovery = new RoomRecoveryCoordinator(session.getScope()!, ports);
    recovery.setPythonReady(true);
    recovery.start();
    try {
      deliver(versioned(2, 'old-song'));
      if (staleWhen === 'before delivery') {
        expect(ports.launch.selectionChanged).not.toHaveBeenCalled();
        expect(ports.voice.synchronize).not.toHaveBeenCalled();
      } else {
        expect(ports.voice.synchronize).toHaveBeenCalledOnce();
        if (staleWhen === 'during library read') {
          complete();
          await pendingVoice;
          expect(ports.python.listSongs).toHaveBeenCalledOnce();
        }
        session.setSnapshot(versioned(3, 'new-song'));
        expect(ports.voice.synchronize.mock.calls[0]?.[2]?.()).toBe(false);
      }
      complete();
      await pendingVoice;
      completeLibrary([]);
      await pendingLibrary;
      if (staleWhen !== 'during library read')
        expect(ports.launch.recordPlaybackTransition).not.toHaveBeenCalled();
      expect(ports.launch.observe).not.toHaveBeenCalled();
      expect(ports.project.reconcileReadiness).not.toHaveBeenCalled();
      expect(session.getRoom()).toMatchObject({
        snapshotRevision: 3,
        songId: 'new-song',
      });
    } finally {
      complete();
      completeLibrary([]);
      recovery.stop();
    }
  },
);

it.each([
  { stale: false, roomRemoved: false },
  { stale: true, roomRemoved: false },
  { stale: false, roomRemoved: true },
  { stale: true, roomRemoved: true },
])(
  'handles a resumed reconciliation failure only while current (stale: $stale, room removed: $roomRemoved)',
  async ({ stale, roomRemoved }) => {
    const initial: RoomStateDto = {
      ...snapshot(),
      snapshotRevision: 1,
      songId: 'song',
      revision: 1,
    };
    const session = new RoomSessionController(
      {
        createRoom: vi.fn(async () => initial),
        joinRoom: vi.fn(async () => initial),
        leaveRoom: vi.fn(async () => undefined),
        closeRoom: vi.fn(async () => undefined),
      },
      {
        joinVoiceSession: vi.fn(async () => undefined),
        setRoomPlayoutDelay: vi.fn(async () => undefined),
        leaveVoiceSession: vi.fn(async () => undefined),
      },
      'self',
    );
    session.setSnapshot(initial);
    let completeLibrary!: (songs: readonly SongDto[]) => void;
    let failLibrary!: (error: Error) => void;
    const pendingLibrary = new Promise<readonly SongDto[]>(
      (resolve, reject) => {
        completeLibrary = resolve;
        failLibrary = reject;
      },
    );
    let completeVoiceExit!: () => void;
    const pendingVoiceExit = new Promise<void>((resolve) => {
      completeVoiceExit = resolve;
    });
    const ports = {
      room: { watchRoom: vi.fn(() => vi.fn()) },
      audio: { leaveVoiceSession: vi.fn(() => pendingVoiceExit) },
      python: { listSongs: vi.fn(() => pendingLibrary) },
      voice: { synchronize: vi.fn(async () => undefined) },
      project: {
        reconcileReadiness: vi.fn(async () => {
          throw Object.assign(new Error('Room removed'), {
            code: 'RoomNotFound',
          });
        }),
      },
      launch: {
        selectionChanged: vi.fn(),
        recordPlaybackTransition: vi.fn(),
        observe: vi.fn(),
        stop: vi.fn(),
      },
      notify: vi.fn(),
      chime: vi.fn(),
    };
    const recovery = new RoomRecoveryCoordinator(session.getScope()!, ports);
    recovery.start();
    try {
      recovery.setPythonReady(true);
      expect(ports.python.listSongs).toHaveBeenCalledOnce();
      if (roomRemoved) {
        completeLibrary([]);
        await vi.waitFor(() =>
          expect(ports.audio.leaveVoiceSession).toHaveBeenCalledOnce(),
        );
      }
      if (stale)
        session.setSnapshot({ ...initial, snapshotRevision: 2, songId: 'new' });
      if (roomRemoved) {
        completeVoiceExit();
        await pendingVoiceExit;
      } else {
        failLibrary(new Error('Library unavailable'));
        await pendingLibrary.catch(() => undefined);
      }
      await Promise.resolve();
      expect(ports.launch.stop).toHaveBeenCalledTimes(stale ? 0 : 1);
      if (stale)
        expect(session.getRoom()).toMatchObject({
          snapshotRevision: 2,
          songId: 'new',
        });
      else if (roomRemoved) expect(session.getRoom()).toBeNull();
      else expect(session.getRoom()?.connectionStatus).toBe('reconnecting');
      if (!roomRemoved) {
        expect(ports.launch.observe).not.toHaveBeenCalled();
        expect(ports.project.reconcileReadiness).not.toHaveBeenCalled();
      }
      expect(ports.notify).toHaveBeenCalledTimes(!stale && roomRemoved ? 1 : 0);
    } finally {
      completeVoiceExit();
      recovery.stop();
    }
  },
);

it('preserves a local import failure that arrives while room voice synchronization is pending', async () => {
  let current = {
    ...snapshot(),
    songId: 'song',
    revision: 1,
    transferProgress: 70,
  };
  let deliver!: (room: RoomStateDto) => void;
  let complete!: () => void;
  const recovery = new RoomRecoveryCoordinator(
    {
      code: 'room-a',
      generation: 1,
      signal: new AbortController().signal,
      isCurrent: () => true,
      getRoom: () => current,
      setSnapshot: (room) => {
        current = room as typeof current;
        return true;
      },
      disconnect: () => true,
    },
    {
      room: {
        watchRoom: vi.fn((_code, onRoom) => {
          deliver = onRoom;
          return vi.fn();
        }),
      },
      audio: { leaveVoiceSession: vi.fn(async () => undefined) },
      python: { listSongs: vi.fn(async () => []) },
      voice: {
        synchronize: () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          }),
      },
      project: { reconcileReadiness: vi.fn(async () => undefined) },
      launch: {
        selectionChanged: vi.fn(),
        recordPlaybackTransition: vi.fn(),
        observe: vi.fn(),
        stop: vi.fn(),
      },
      notify: vi.fn(),
      chime: vi.fn(),
    },
  );
  recovery.start();
  deliver({
    ...current,
    participants: current.participants.map((person) => ({
      ...person,
      readiness: 'failed',
    })),
  });
  await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
  current = roomTransferFailure(current, true) as typeof current;
  complete();
  await vi.waitFor(() =>
    expect(current.participants[0]?.readiness).toBe('failed'),
  );
  expect(current).toMatchObject({
    transferError: true,
    transferConflict: true,
    transferProgress: undefined,
  });
  recovery.stop();
});

it('does not apply a snapshot that waited on AudioService after the session changed', async () => {
  let active = true;
  let current = snapshot();
  let deliver!: (room: RoomStateDto) => void;
  let complete!: () => void;
  const scope: RoomSessionScope = {
    code: 'room-a',
    generation: 1,
    signal: new AbortController().signal,
    isCurrent: () => active,
    getRoom: () => (active ? current : null),
    setSnapshot: vi.fn((room) => {
      if (!active) return false;
      current = room;
      return true;
    }),
    disconnect: vi.fn(() => {
      active = false;
      return true;
    }),
  };
  const ports = {
    room: {
      watchRoom: vi.fn((_code, onRoom) => {
        deliver = onRoom;
        return vi.fn();
      }),
    },
    audio: { leaveVoiceSession: vi.fn(async () => undefined) },
    python: { listSongs: vi.fn(async () => []) },
    voice: {
      synchronize: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          }),
      ),
    },
    project: { reconcileReadiness: vi.fn(async () => undefined) },
    launch: {
      selectionChanged: vi.fn(),
      recordPlaybackTransition: vi.fn(),
      observe: vi.fn(),
      stop: vi.fn(),
    },
    notify: vi.fn(),
    chime: vi.fn(),
  };
  const recovery = new RoomRecoveryCoordinator(scope, ports);
  recovery.start();
  deliver({ ...snapshot(), serverClockOffsetMilliseconds: 23 });
  await vi.waitFor(() =>
    expect(ports.voice.synchronize).toHaveBeenCalledOnce(),
  );
  active = false;
  complete();
  await Promise.resolve();
  expect(scope.setSnapshot).not.toHaveBeenCalled();
  expect(ports.python.listSongs).not.toHaveBeenCalled();
  recovery.stop();
});

it('resumes project reconciliation when Python becomes ready without another server event', async () => {
  let deliver!: (room: RoomStateDto) => void;
  let current: RoomStateDto = {
    ...snapshot(),
    songId: 'song',
    revision: 1,
    selectionId: 1,
  };
  const scope: RoomSessionScope = {
    code: 'room-a',
    generation: 1,
    signal: new AbortController().signal,
    isCurrent: () => true,
    getRoom: () => current,
    setSnapshot: (room) => {
      current = room;
      return true;
    },
    disconnect: () => true,
  };
  const ports = {
    room: {
      watchRoom: vi.fn((_code, onRoom) => {
        deliver = onRoom;
        return vi.fn();
      }),
    },
    audio: { leaveVoiceSession: vi.fn(async () => undefined) },
    python: { listSongs: vi.fn(async () => []) },
    voice: { synchronize: vi.fn(async () => undefined) },
    project: { reconcileReadiness: vi.fn(async () => undefined) },
    launch: {
      selectionChanged: vi.fn(),
      recordPlaybackTransition: vi.fn(),
      observe: vi.fn(),
      stop: vi.fn(),
    },
    notify: vi.fn(),
    chime: vi.fn(),
  };
  const recovery = new RoomRecoveryCoordinator(scope, ports);
  recovery.start();
  deliver(current);
  await vi.waitFor(() =>
    expect(ports.voice.synchronize).toHaveBeenCalledOnce(),
  );
  expect(ports.python.listSongs).not.toHaveBeenCalled();
  recovery.setPythonReady(true);
  await vi.waitFor(() =>
    expect(ports.project.reconcileReadiness).toHaveBeenCalledOnce(),
  );
  deliver({ ...current, selectionId: 3 });
  await vi.waitFor(() =>
    expect(ports.launch.selectionChanged).toHaveBeenCalledWith(
      expect.objectContaining({ selectionId: 3 }),
    ),
  );
  recovery.stop();
});

it('cancels a pending launch when the Room Server disconnects', async () => {
  let disconnected!: (error: unknown) => void;
  let current = snapshot();
  const scope: RoomSessionScope = {
    code: 'room-a',
    generation: 1,
    signal: new AbortController().signal,
    isCurrent: () => true,
    getRoom: () => current,
    setSnapshot: (room) => {
      current = room;
      return true;
    },
    disconnect: () => true,
  };
  const launch = {
    selectionChanged: vi.fn(),
    recordPlaybackTransition: vi.fn(),
    observe: vi.fn(),
    stop: vi.fn(),
  };
  const recovery = new RoomRecoveryCoordinator(scope, {
    room: {
      watchRoom: vi.fn((_code, _onRoom, onError) => {
        disconnected = onError;
        return vi.fn();
      }),
    },
    audio: { leaveVoiceSession: vi.fn(async () => undefined) },
    python: { listSongs: vi.fn(async () => []) },
    voice: { synchronize: vi.fn(async () => undefined) },
    project: { reconcileReadiness: vi.fn(async () => undefined) },
    launch,
    notify: vi.fn(),
    chime: vi.fn(),
  });
  recovery.start();
  disconnected(new Error('Room Server unavailable'));
  await vi.waitFor(() => expect(current.connectionStatus).toBe('reconnecting'));
  expect(launch.stop).toHaveBeenCalledOnce();
  recovery.stop();
});
