import { expect, it, vi } from 'vitest';
import type { RoomStateDto, SongDto } from '../../contracts/models';
import { RoomSessionController } from './RoomSessionController';
import type { RoomClient } from '../../contracts/clients';
import { RoomProjectCoordinator } from './RoomProjectCoordinator';

import { deferred, setup } from '../../../test-fixtures/roomProject';

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

it('keeps a local import conflict when its failure acknowledgement is older than the current server snapshot', async () => {
  const { services, getRoom } = setup();
  const initial: RoomStateDto = {
    ...getRoom(),
    songId: 'song',
    revision: 1,
    selectionId: 1,
    snapshotRevision: 1,
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
      leaveVoiceSession: vi.fn(async () => undefined),
      setRoomPlayoutDelay: vi.fn(async () => undefined),
    },
    'self',
  );
  session.setSnapshot(initial);
  const pending = deferred<RoomStateDto>();
  let failed!: RoomStateDto;
  let revision = 1;
  const setRoomReadiness = vi.fn<RoomClient['setRoomReadiness']>(
    async (_code, readiness) => {
      const saved = { ...session.getRoom()!, snapshotRevision: ++revision };
      if (readiness === 'Failed') {
        failed = saved;
        return pending.promise;
      }
      return saved;
    },
  );
  services.python.importProject.mockRejectedValueOnce({
    code: 'PackageConflict',
    message: 'The local song has a different revision',
    source: 'python',
  });
  const coordinator = new RoomProjectCoordinator(session.getScope()!, {
    ...services,
    room: { ...services.room, setRoomReadiness },
  });
  const importing = coordinator.prepare('song', 1);
  await vi.waitFor(() => expect(failed).toBeDefined());
  const newer = {
    ...failed,
    snapshotRevision: ++revision,
    libraryQuery: 'new shared query',
  };
  session.setSnapshot(newer);
  pending.resolve(failed);
  await importing;

  expect(session.getRoom()).toMatchObject({
    snapshotRevision: newer.snapshotRevision,
    libraryQuery: 'new shared query',
    transferError: true,
    transferConflict: true,
  });
  expect(services.desktop.releaseRoomProjectDownload).toHaveBeenCalledWith(
    'archive.zip',
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
