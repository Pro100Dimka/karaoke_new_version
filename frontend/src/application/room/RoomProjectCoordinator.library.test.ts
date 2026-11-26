import { expect, it, vi } from 'vitest';
import type { SongDto } from '../../contracts/models';
import { RoomProjectCoordinator } from './RoomProjectCoordinator';
import { deferred, setup } from '../../../test-fixtures/roomProject';

it('keeps a declined file declaration stopped until an explicit retry', async () => {
  vi.useFakeTimers();
  const { services, coordinator, getRoom, setRoom } = setup();
  const song: SongDto = {
    id: 'song',
    title: 'Tone',
    artist: 'Tone',
    activeRevision: 1,
    status: 'ready',
    language: 'Auto',
    coverState: 'Fallback',
    durationSeconds: 1,
    createdAt: '',
    projectFormatVersion: 2,
  };
  setRoom({
    ...getRoom(),
    songId: song.id,
    revision: 1,
    selectionId: 1,
    participants: [
      {
        id: 'guest',
        name: 'Guest',
        role: 'participant',
        self: false,
        connected: true,
        readiness: 'missing',
        muted: false,
        volume: 1,
      },
    ],
  });
  services.python.listSongs.mockResolvedValue([song]);
  services.desktop.uploadRoomProject.mockRejectedValueOnce(
    new Error('File upload was cancelled'),
  );
  const logging = vi
    .spyOn(console, 'error')
    .mockImplementation(() => undefined);
  try {
    coordinator.setPythonReady(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(services.desktop.uploadRoomProject).toHaveBeenCalledOnce();
    expect(services.room.setRoomReadiness).toHaveBeenCalledWith(
      'room-a',
      'Failed',
      1,
    );
    expect(getRoom().transferError).toBe(true);
    await coordinator.reconcileReadiness(getRoom(), [song]);
    expect(services.room.setRoomReadiness).not.toHaveBeenCalledWith(
      'room-a',
      'Preparing',
      1,
    );
    await coordinator.retry();
    await vi.advanceTimersByTimeAsync(1000);
    expect(services.desktop.uploadRoomProject).toHaveBeenCalledTimes(2);
  } finally {
    coordinator.stop();
    logging.mockRestore();
    vi.useRealTimers();
  }
});

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
    get title() {
      return 'Old title';
    },
    artist: 'Old artist',
    projectHash: 'a'.repeat(64),
  } as SongDto;
  const titleReads = vi.spyOn(publishedSong, 'title', 'get');
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
    expect(titleReads).toHaveBeenCalledOnce();
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

it.each(['export', 'upload'] as const)(
  'publishes a newly processed song while another project is still in %s',
  async (blocked) => {
    vi.useFakeTimers();
    const { services, scope, getRoom, setRoom } = setup();
    const song: SongDto = {
      id: 'selected',
      activeRevision: 1,
      status: 'ready',
      title: 'Selected',
      artist: 'Singer',
      language: 'Auto',
      coverState: 'Fallback',
      durationSeconds: 60,
      createdAt: '',
      projectFormatVersion: 1,
    };
    const processed: SongDto = {
      ...song,
      id: 'processed',
      title: 'Freshly processed',
    };
    setRoom({
      ...getRoom(),
      songId: song.id,
      revision: 1,
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
    const exporting = deferred<string>(),
      uploading = deferred<void>();
    if (blocked === 'export')
      services.python.exportProject.mockReturnValueOnce(exporting.promise);
    else
      services.desktop.uploadRoomProject.mockReturnValueOnce(uploading.promise);
    services.python.listSongs.mockResolvedValue([
      song,
      { ...processed, status: 'processing' },
    ]);
    let changed: () => void = () => undefined;
    const coordinator = new RoomProjectCoordinator(scope, {
      ...services,
      python: {
        ...services.python,
        onLibraryChange: (listener) => {
          changed = listener;
          return () => undefined;
        },
      },
    });
    try {
      coordinator.setPythonReady(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(services.room.publishLibrary).toHaveBeenLastCalledWith('room-a', [
        song,
      ]);
      expect(services.python.exportProject).toHaveBeenCalledOnce();
      services.python.listSongs.mockResolvedValue([song, processed]);
      changed();
      await vi.advanceTimersByTimeAsync(0);
      expect(services.room.publishLibrary).toHaveBeenLastCalledWith('room-a', [
        song,
        processed,
      ]);
      expect(services.python.exportProject).toHaveBeenCalledOnce();
      setRoom({ ...getRoom(), songId: processed.id });
      await vi.advanceTimersByTimeAsync(1000);
      expect(services.desktop.cancelRoomProjectTransfer).toHaveBeenCalledOnce();
      expect(services.python.exportProject).toHaveBeenCalledTimes(2);
    } finally {
      coordinator.stop();
      exporting.resolve('archive.zip');
      uploading.resolve();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  },
);
