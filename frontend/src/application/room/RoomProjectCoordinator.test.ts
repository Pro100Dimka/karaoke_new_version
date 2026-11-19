import { expect, it, vi } from 'vitest';
import type { RoomStateDto, SongDto } from '../../contracts/models';
import type { RoomSessionScope } from './RoomSessionController';
import { RoomProjectCoordinator } from './RoomProjectCoordinator';

it('does not publish an empty placeholder while the initial library read is pending or retired', async () => {
  vi.useFakeTimers();
  const { services, coordinator } = setup();
  const pending = deferred<readonly SongDto[]>();
  services.python.listSongs.mockReturnValueOnce(pending.promise);
  try {
    coordinator.setPythonReady(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(services.room.publishLibrary).not.toHaveBeenCalled();

    coordinator.setPythonReady(false);
    pending.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(services.room.publishLibrary).not.toHaveBeenCalled();

    coordinator.setPythonReady(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(services.room.publishLibrary).toHaveBeenCalledExactlyOnceWith(
      'room-a',
      [],
    );
  } finally {
    coordinator.stop();
    vi.useRealTimers();
  }
});

it('publishes an empty library once on joining and again after backend recovery', async () => {
  vi.useFakeTimers();
  const { services, coordinator } = setup();
  try {
    coordinator.setPythonReady(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(services.room.publishLibrary).toHaveBeenCalledExactlyOnceWith(
      'room-a',
      [],
    );

    coordinator.setPythonReady(false);
    coordinator.setPythonReady(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(services.room.publishLibrary).toHaveBeenCalledTimes(2);
    expect(services.room.publishLibrary).toHaveBeenLastCalledWith('room-a', []);
  } finally {
    coordinator.stop();
    vi.useRealTimers();
  }
});

it('withdraws songs deleted while the backend was unavailable', async () => {
  vi.useFakeTimers();
  const { services, coordinator } = setup();
  const song = {
    id: 'deleted-song',
    activeRevision: 1,
    status: 'ready',
    title: 'Deleted song',
    artist: 'Artist',
  } as SongDto;
  services.python.listSongs.mockResolvedValue([song]);
  try {
    coordinator.setPythonReady(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(services.room.publishLibrary).toHaveBeenLastCalledWith('room-a', [
      song,
    ]);

    coordinator.setPythonReady(false);
    services.python.listSongs.mockResolvedValue([]);
    coordinator.setPythonReady(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(services.room.publishLibrary).toHaveBeenCalledTimes(2);
    expect(services.room.publishLibrary).toHaveBeenLastCalledWith('room-a', []);
  } finally {
    coordinator.stop();
    vi.useRealTimers();
  }
});

it('refreshes the library on changes without reading it every second', async () => {
  vi.useFakeTimers();
  const { services, scope } = setup();
  const publishedSong = {
    id: 'song',
    activeRevision: 1,
    status: 'ready',
    title: 'Old title',
    artist: 'Old artist',
    projectHash: 'a'.repeat(64),
  } as SongDto;
  services.python.listSongs.mockResolvedValue([publishedSong]);
  let changed: () => void = () => undefined;
  const unsubscribe = vi.fn();
  const coordinator = new RoomProjectCoordinator(scope, {
    ...services,
    python: {
      ...services.python,
      onLibraryChange: (listener: () => void) => {
        changed = listener;
        return unsubscribe;
      },
    },
  });
  try {
    coordinator.setPythonReady(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(services.python.listSongs).toHaveBeenCalledTimes(1);
    expect(services.room.publishLibrary).toHaveBeenCalledTimes(1);
    services.python.listSongs.mockResolvedValue([
      { ...publishedSong, title: 'New title', artist: 'New artist' },
    ]);
    changed();
    await vi.advanceTimersByTimeAsync(0);
    expect(services.python.listSongs).toHaveBeenCalledTimes(2);
    expect(services.room.publishLibrary).toHaveBeenCalledTimes(2);
    coordinator.stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  } finally {
    coordinator.stop();
    vi.useRealTimers();
  }
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const setup = () => {
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

it('counts video archive upload before download and keeps byte updates within one percent', async () => {
  const { coordinator, getRoom, setRoom, progress, services } = setup();
  setRoom({ ...getRoom(), transferId: 'transfer', transferProgress: 10 });
  coordinator.start();
  progress({
    transferId: 'transfer',
    direction: 'upload',
    transferredBytes: 500_000_000,
    totalBytes: 1_000_000_000,
  });
  await vi.waitFor(() => expect(getRoom().transferProgress).toBe(23));
  expect(getRoom().transferTotalBytes).toBe(1_000_000_000);
  expect(getRoom().transferPhase).toBe('upload');
  const calls = services.room.setRoomReadiness.mock.calls.length;
  progress({
    transferId: 'transfer',
    direction: 'upload',
    transferredBytes: 500_001_000,
    totalBytes: 1_000_000_000,
  });
  await vi.waitFor(() => expect(getRoom().transferBytes).toBe(500_001_000));
  expect(services.room.setRoomReadiness).toHaveBeenCalledTimes(calls);
  progress({
    transferId: 'transfer',
    direction: 'download',
    transferredBytes: 0,
    totalBytes: 1_000_000_000,
  });
  await vi.waitFor(() => expect(getRoom().transferProgress).toBe(35));
  coordinator.stop();
});

it.each(['direct', 'mapped', 'hash'])(
  'loads selected artwork from the %s local copy',
  async (matching) => {
    const { coordinator, services, getRoom, setRoom } = setup();
    const projectHash = 'a'.repeat(64);
    setRoom({
      ...getRoom(),
      songId: 'remote-song',
      revision: 1,
      ...(matching === 'hash' && {
        sharedSongs: [
          {
            songId: 'remote-song',
            revision: 1,
            projectHash,
            ownerParticipantId: 'host',
            title: 'Song',
            artist: 'Artist',
            durationSeconds: 10,
          },
        ],
      }),
    });
    const localId = matching === 'direct' ? 'remote-song' : 'local-song';
    if (matching === 'mapped') services.copies.get.mockReturnValue(localId);
    services.python.listSongs.mockResolvedValue([
      {
        id: localId,
        activeRevision: 1,
        status: 'ready',
        title: 'Song',
        artworkUrl: 'local-cover.jpg',
        projectHash,
      } as SongDto,
    ]);
    expect(await coordinator.selectedArtwork()).toEqual({
      songId: 'remote-song',
      title: 'Song',
      url: 'local-cover.jpg',
    });
  },
);

it('cancels transfer on leave and releases a late archive without importing it', async () => {
  const { coordinator, services, leave, getRoom } = setup();
  const downloading = deferred<string>();
  services.desktop.downloadRoomProject.mockReturnValue(downloading.promise);
  const preparing = coordinator.prepare('song', 1);
  await vi.waitFor(() =>
    expect(services.desktop.downloadRoomProject).toHaveBeenCalledOnce(),
  );

  const beforeLeave = getRoom();
  leave();
  coordinator.cancel();
  downloading.resolve('late.zip');
  await preparing;

  expect(services.desktop.cancelRoomProjectTransfer).toHaveBeenCalledOnce();
  expect(services.desktop.releaseRoomProjectDownload).toHaveBeenCalledWith(
    'late.zip',
  );
  expect(services.python.importProject).not.toHaveBeenCalled();
  expect(getRoom()).toBe(beforeLeave);
});

it.each(['retry', 'selection'])(
  'keeps an explicitly cancelled transfer stopped until %s',
  async (action) => {
    const { coordinator, services, getRoom, setRoom } = setup();
    setRoom({ ...getRoom(), songId: 'song', revision: 1, selectionId: 1 });
    const downloading = deferred<string>();
    services.desktop.downloadRoomProject.mockReturnValueOnce(
      downloading.promise,
    );
    const preparation = coordinator.prepare('song', 1);
    await vi.waitFor(() =>
      expect(services.desktop.downloadRoomProject).toHaveBeenCalledOnce(),
    );
    coordinator.cancelTransfer();
    downloading.resolve('cancelled.zip');
    await preparation;
    coordinator.cancel();
    await coordinator.prepare('song', 1);
    await coordinator.prepare('song', 1);
    expect(services.desktop.downloadRoomProject).toHaveBeenCalledOnce();
    expect(services.python.importProject).not.toHaveBeenCalled();
    expect(getRoom().transferError).toBe(true);
    expect(services.room.setRoomReadiness).toHaveBeenCalledWith(
      'room-a',
      'Failed',
      1,
    );
    if (action === 'retry') await coordinator.retry();
    else setRoom({ ...getRoom(), selectionId: 2 });
    await coordinator.prepare('song', 1);
    expect(services.desktop.downloadRoomProject).toHaveBeenCalledTimes(2);
    expect(services.python.importProject).toHaveBeenCalledOnce();
  },
);

it('waits for cancellation publication before sending an explicit retry', async () => {
  const { coordinator, services, getRoom, setRoom } = setup();
  setRoom({ ...getRoom(), songId: 'song', revision: 1, selectionId: 1 });
  const downloading = deferred<string>();
  services.desktop.downloadRoomProject.mockReturnValueOnce(downloading.promise);
  const preparing = coordinator.prepare('song', 1);
  await vi.waitFor(() =>
    expect(services.desktop.downloadRoomProject).toHaveBeenCalledOnce(),
  );
  const cancellation = deferred<RoomStateDto>();
  services.room.setRoomReadiness.mockReturnValueOnce(cancellation.promise);
  coordinator.cancelTransfer();
  const retry = coordinator.retry();
  expect(services.room.setRoomReadiness).not.toHaveBeenCalledWith(
    'room-a',
    'MissingSong',
    1,
  );
  cancellation.resolve(getRoom());
  await retry;
  expect(services.room.setRoomReadiness).toHaveBeenLastCalledWith(
    'room-a',
    'MissingSong',
    1,
  );
  downloading.resolve('cancelled.zip');
  await preparing;
});

it('starts a new preparation when the same song is selected in a new generation', async () => {
  const { coordinator, services, getRoom, setRoom } = setup();
  setRoom({ ...getRoom(), songId: 'song', revision: 1, selectionId: 1 });
  const downloading = deferred<string>();
  services.desktop.downloadRoomProject.mockReturnValueOnce(downloading.promise);
  const first = coordinator.prepare('song', 1);
  await vi.waitFor(() =>
    expect(services.desktop.downloadRoomProject).toHaveBeenCalledOnce(),
  );
  setRoom({ ...getRoom(), selectionId: 3 });
  await coordinator.prepare('song', 1);
  expect(services.desktop.downloadRoomProject).toHaveBeenCalledTimes(2);
  downloading.resolve('old-generation.zip');
  await first;
  expect(services.python.importProject).toHaveBeenCalledOnce();
  expect(services.desktop.releaseRoomProjectDownload).toHaveBeenCalledWith(
    'old-generation.zip',
  );
  expect(services.room.setRoomReadiness).toHaveBeenLastCalledWith(
    'room-a',
    'Preparing',
    3,
    95,
  );
});

it("keeps replacement consent inside this room's project coordinator", async () => {
  const first = setup();
  first.setRoom({ ...first.getRoom(), songId: 'song', revision: 2 });
  await first.coordinator.replaceProject();
  expect(first.services.room.setRoomReadiness).toHaveBeenCalledWith(
    'room-a',
    'MissingSong',
    0,
  );
  expect(first.coordinator.importDecision('song', 2)).toBe('AcceptDivergent');
  const nextSession = setup();
  expect(nextSession.coordinator.importDecision('song', 2)).toBe('AcceptOlder');
});

it('does not restore an old selection when its retry response arrives late', async () => {
  const { coordinator, services, getRoom, setRoom } = setup();
  setRoom({ ...getRoom(), songId: 'old', revision: 1 });
  const pending = deferred<RoomStateDto>();
  services.room.setRoomReadiness.mockReturnValue(pending.promise);
  const retry = coordinator.retry();
  setRoom({ ...getRoom(), songId: 'new', revision: 2 });
  pending.resolve({ ...getRoom(), songId: 'old', revision: 1 });
  await retry;
  expect(getRoom().songId).toBe('new');
});

it('records partial import failure, releases the archive, and allows explicit retry', async () => {
  const { coordinator, services, getRoom } = setup();
  services.python.importProject.mockRejectedValueOnce(
    new Error('invalid archive'),
  );

  await coordinator.prepare('song', 1);
  expect(services.room.setRoomReadiness).toHaveBeenCalledWith(
    'room-a',
    'Failed',
    0,
  );
  expect(getRoom().transferError).toBe(true);
  expect(services.desktop.releaseRoomProjectDownload).toHaveBeenCalledWith(
    'archive.zip',
  );

  await coordinator.prepare('song', 1);
  expect(services.python.importProject).toHaveBeenCalledTimes(2);
  expect(services.copies.remember).toHaveBeenCalledWith(
    'song',
    1,
    'local-song',
  );
});

it('coalesces byte progress and ignores an old readiness response after import begins', async () => {
  const { coordinator, services, setRoom, getRoom, progress } = setup();
  let complete!: (value: RoomStateDto) => void;
  services.room.setRoomReadiness.mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  setRoom({ ...getRoom(), transferId: 'transfer', transferProgress: 10 });
  coordinator.start();
  for (let transferredBytes = 1; transferredBytes <= 50; transferredBytes += 1)
    progress({
      transferId: 'transfer',
      direction: 'download',
      transferredBytes,
      totalBytes: 100,
    });
  await vi.waitFor(() =>
    expect(services.room.setRoomReadiness).toHaveBeenCalledOnce(),
  );
  setRoom({ ...getRoom(), transferProgress: 70 });
  complete(getRoom());
  await vi.waitFor(() => expect(getRoom().transferProgress).toBe(70));
  coordinator.stop();
});

it.each([false, true])(
  'cancels an in-flight project upload when the session stops (same source: %s)',
  async (sameSource) => {
    const { coordinator, services, setRoom, getRoom } = setup();
    setRoom({
      ...getRoom(),
      songId: 'song',
      revision: 1,
      sharedSongs: sameSource
        ? [
            {
              songId: 'guest-song',
              revision: 2,
              title: 'Song',
              artist: 'Artist',
              durationSeconds: 60,
              ownerParticipantId: 'guest',
              sourceHash: 'a'.repeat(64),
              projectHash: 'c'.repeat(64),
            },
          ]
        : [],
      participants: [
        {
          id: 'guest',
          name: 'Guest',
          role: 'participant',
          self: false,
          connected: true,
          muted: false,
          volume: 1,
          readiness: 'missing',
        },
      ],
    });
    services.python.listSongs.mockResolvedValue([
      {
        id: 'song',
        activeRevision: 1,
        status: 'ready',
        sourceHash: 'a'.repeat(64),
        projectHash: 'b'.repeat(64),
      } as SongDto,
    ]);
    let finish!: () => void;
    services.desktop.uploadRoomProject.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );

    coordinator.start();
    coordinator.setPythonReady(true);
    await vi.waitFor(() =>
      expect(services.desktop.uploadRoomProject).toHaveBeenCalledOnce(),
    );
    const transferId =
      services.desktop.uploadRoomProject.mock.calls[0]?.[0].transferId;
    coordinator.stop();
    expect(services.desktop.cancelRoomProjectTransfer).toHaveBeenCalledWith(
      transferId,
    );
    finish();
  },
);

it('reconciles local readiness without declaring the server room playable early', async () => {
  const { coordinator, services, getRoom, setRoom } = setup();
  setRoom({
    ...getRoom(),
    songId: 'song',
    revision: 1,
    participants: [
      {
        id: 'self',
        name: 'Self',
        role: 'participant',
        self: true,
        connected: true,
        readiness: 'missing',
        muted: false,
        volume: 1,
      },
    ],
  });
  await coordinator.reconcileReadiness(getRoom(), [
    { id: 'song', activeRevision: 1, status: 'ready' } as SongDto,
  ]);
  expect(services.room.setRoomReadiness).toHaveBeenCalledWith(
    'room-a',
    'Preparing',
    0,
  );
  expect(services.room.setRoomReadiness).not.toHaveBeenCalledWith(
    'room-a',
    'Ready',
    0,
  );
});
