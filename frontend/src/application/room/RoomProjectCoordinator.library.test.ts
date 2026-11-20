import { expect, it, vi } from 'vitest';
import type { SongDto } from '../../contracts/models';
import { RoomProjectCoordinator } from './RoomProjectCoordinator';
import { deferred, setup } from '../../../test-fixtures/roomProject';

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
