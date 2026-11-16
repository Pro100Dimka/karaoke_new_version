import { expect, it, vi } from 'vitest';
import type { ParticipantDto, RoomStateDto } from '../../contracts/models';
import { RoomSessionController } from './RoomSessionController';
import { RoomPlaybackCoordinator } from './RoomPlaybackCoordinator';

const room = (code = 'A'): RoomStateDto => ({
  code,
  role: 'host',
  hostId: 'host',
  participants: [],
  playbackLocked: false,
  playbackState: 'stopped',
});
const selectedRoom = (
  readiness: ParticipantDto['readiness'],
): RoomStateDto => ({
  ...room(),
  hostId: 'self',
  songId: 'song',
  revision: 1,
  selectionId: 1,
  participants: [
    {
      id: 'self',
      name: 'Me',
      role: 'host',
      self: true,
      connected: true,
      muted: false,
      volume: 1,
      readiness,
    },
  ],
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const setup = () => {
  const transport = {
    createRoom: vi.fn(async () => room()),
    joinRoom: vi.fn(async (code: string) => room(code)),
    leaveRoom: vi.fn(async () => undefined),
    closeRoom: vi.fn(async () => undefined),
    roomControl: vi.fn(async (): Promise<RoomStateDto> => ({
      ...room(),
      playbackState: 'playing',
    })),
    clearRoomSong: vi.fn(async () => room()),
    advancePlaylist: vi.fn(async () => room()),
    updateSharedState: vi.fn(async () => room()),
    setRoomReadiness: vi.fn(async () => room()),
    publishPerformance: vi.fn(async () => undefined),
    getRoom: vi.fn(async (): Promise<RoomStateDto> => room()),
  };
  const audio = {
    joinVoiceSession: vi.fn(async () => undefined),
    setRoomPlayoutDelay: vi.fn(async () => undefined),
    leaveVoiceSession: vi.fn(async () => undefined),
  };
  const session = new RoomSessionController(transport, audio, 'self');
  return { transport, session };
};

it('keeps the playlist only for a natural server stop', async () => {
  const { transport, session } = setup();
  session.setSnapshot(room());
  const playback = new RoomPlaybackCoordinator(session.getScope()!, transport);
  await playback.control('Stop', undefined, true);
  expect(transport.roomControl).toHaveBeenLastCalledWith(
    'A',
    'Stop',
    undefined,
    true,
  );
  await playback.control('Stop');
  expect(transport.roomControl).toHaveBeenLastCalledWith(
    'A',
    'Stop',
    undefined,
    false,
  );
});

it('acknowledges the saved take and applies the server playlist selection', async () => {
  const { transport, session } = setup();
  session.setSnapshot({
    ...room(),
    performanceId: 7,
    songId: 'one',
    playlist: {
      name: 'Set',
      index: 0,
      songs: [
        { songId: 'one', revision: 1 },
        { songId: 'two', revision: 1 },
      ],
    },
  });
  transport.advancePlaylist.mockResolvedValue({
    ...room(),
    performanceId: 8,
    songId: 'two',
  });
  const playback = new RoomPlaybackCoordinator(session.getScope()!, transport);
  await playback.advancePlaylist(7);
  expect(transport.advancePlaylist).toHaveBeenCalledWith('A', 7);
  expect(session.getScope()?.getRoom()?.songId).toBe('two');
});

it('publishes the analysis composite in the background and obtains a canonical saved result', async () => {
  const { transport, session } = setup();
  session.setSnapshot({ ...room(), songId: 'song', performanceId: 7 });
  const playback = new RoomPlaybackCoordinator(session.getScope()!, transport);
  const score = {
    hitNotes: 1,
    totalNotes: 1,
    assessedPitchSeconds: 2,
    pitchAccuracyPercent: 90,
    rhythmAccuracyPercent: 60,
    noteStabilityPercent: 30,
  };
  await playback.publishPerformance(7, score);
  await playback.publishPerformance(7, score);
  expect(transport.publishPerformance).toHaveBeenCalledOnce();
  expect(transport.publishPerformance).toHaveBeenLastCalledWith(
    'A',
    7,
    60,
    2,
    false,
  );
  transport.getRoom.mockResolvedValue({
    ...room(),
    performanceId: 7,
    lastPerformanceId: 7,
    lastPerformanceAccuracy: 84,
  });
  expect(await playback.finalPerformance()).toEqual({
    roomId: 'A',
    performanceId: 7,
    overallScore: 84,
  });
  expect(transport.publishPerformance).toHaveBeenLastCalledWith(
    'A',
    7,
    60,
    2,
    true,
  );
});

it('coalesces duplicate starts within one room generation', async () => {
  const { transport, session } = setup();
  session.setSnapshot(room());
  const pending = deferred<RoomStateDto>();
  transport.roomControl.mockReturnValue(pending.promise);
  const playback = new RoomPlaybackCoordinator(session.getScope()!, transport);
  const first = playback.start();
  const second = playback.start();
  expect(transport.roomControl).toHaveBeenCalledOnce();
  pending.resolve({ ...room(), playbackState: 'playing' });
  await Promise.all([first, second]);
  expect(session.getRoom()?.playbackState).toBe('playing');
});

it('start followed by leave cannot revive the departed room', async () => {
  const { transport, session } = setup();
  session.setSnapshot(room());
  const pending = deferred<RoomStateDto>();
  transport.roomControl.mockReturnValue(pending.promise);
  const playback = new RoomPlaybackCoordinator(session.getScope()!, transport);
  const start = playback.start();
  await session.leave();
  pending.resolve({ ...room(), playbackState: 'playing' });
  await start;
  expect(session.getRoom()).toBeNull();
});

it('a response from room A cannot update room B', async () => {
  const { transport, session } = setup();
  session.setSnapshot(room());
  const pending = deferred<RoomStateDto>();
  transport.roomControl.mockReturnValue(pending.promise);
  const playback = new RoomPlaybackCoordinator(session.getScope()!, transport);
  const start = playback.start();
  await session.leave();
  await session.join('Singer', 'B');
  pending.resolve({ ...room(), playbackState: 'playing' });
  await start;
  expect(session.getRoom()?.code).toBe('B');
  expect(session.getRoom()?.playbackState).toBe('stopped');
});

it('a failed start releases the single-flight slot for retry', async () => {
  const { transport, session } = setup();
  session.setSnapshot(room());
  transport.roomControl.mockRejectedValueOnce(
    new Error('Room Server unavailable'),
  );
  const playback = new RoomPlaybackCoordinator(session.getScope()!, transport);
  await expect(playback.start()).rejects.toThrow('Room Server unavailable');
  await playback.start();
  expect(transport.roomControl).toHaveBeenCalledTimes(2);
});

it('reports audio preparation once per selection and ignores its stale response', async () => {
  const { transport, session } = setup();
  session.setSnapshot({ ...room(), songId: 'song', revision: 1 });
  const pending = deferred<RoomStateDto>();
  transport.setRoomReadiness.mockReturnValue(pending.promise);
  const playback = new RoomPlaybackCoordinator(session.getScope()!, transport);
  const first = playback.reportReady('song', 1);
  const second = playback.reportReady('song', 1);
  expect(transport.setRoomReadiness).toHaveBeenCalledOnce();
  await session.leave();
  pending.resolve({ ...room(), songId: 'song', revision: 1 });
  await Promise.all([first, second]);
  expect(session.getRoom()).toBeNull();
});

it.each(['audio', 'failed', 'missing'] as const)(
  'confirms the same loaded selection again when the server reports %s',
  async (readiness) => {
    const { transport, session } = setup();
    session.setSnapshot(selectedRoom('ready'));
    transport.setRoomReadiness.mockResolvedValue(selectedRoom('ready'));
    const scope = session.getScope();
    if (!scope) throw new Error('Room scope missing');
    const playback = new RoomPlaybackCoordinator(scope, transport);
    await playback.reportReady('song', 1);
    await playback.reportReady('song', 1);
    expect(transport.setRoomReadiness).toHaveBeenCalledTimes(1);
    session.setSnapshot(selectedRoom(readiness));
    await playback.reportReady('song', 1);
    expect(transport.setRoomReadiness).toHaveBeenCalledTimes(2);
    expect(
      session.getRoom()?.participants.find((person) => person.self)?.readiness,
    ).toBe('ready');
  },
);

it('preserves a newer server readiness snapshot over a delayed ready reply', async () => {
  const { transport, session } = setup();
  session.setSnapshot(selectedRoom('audio'));
  const scope = session.getScope();
  if (!scope) throw new Error('Room scope missing');
  const pending = deferred<RoomStateDto>();
  transport.setRoomReadiness.mockReturnValueOnce(pending.promise);
  const playback = new RoomPlaybackCoordinator(scope, transport);
  const reporting = playback.reportReady('song', 1);
  const newer = selectedRoom('missing');
  session.setSnapshot(newer);
  pending.resolve(selectedRoom('ready'));
  await reporting;
  expect(session.getRoom()).toBe(newer);
  transport.setRoomReadiness.mockResolvedValueOnce(selectedRoom('ready'));
  await playback.reportReady('song', 1);
  expect(transport.setRoomReadiness).toHaveBeenCalledTimes(2);
});

it('rejects a late ready response after the same song is selected again', async () => {
  const { transport, session } = setup();
  session.setSnapshot({
    ...room(),
    songId: 'song',
    revision: 1,
    selectionId: 1,
  });
  const pending = deferred<RoomStateDto>();
  transport.setRoomReadiness.mockReturnValueOnce(pending.promise);
  const scope = session.getScope();
  if (!scope) throw new Error('Room scope missing');
  const playback = new RoomPlaybackCoordinator(scope, transport);
  const first = playback.reportReady('song', 1);
  session.setSnapshot({
    ...room(),
    songId: 'song',
    revision: 1,
    selectionId: 3,
  });
  pending.resolve({ ...room(), songId: 'song', revision: 1, selectionId: 1 });
  await first;
  expect(session.getRoom()?.selectionId).toBe(3);
  transport.setRoomReadiness.mockResolvedValueOnce({
    ...room(),
    songId: 'song',
    revision: 1,
    selectionId: 3,
  });
  await playback.reportReady('song', 1);
  expect(transport.setRoomReadiness).toHaveBeenNthCalledWith(
    1,
    room().code,
    'Ready',
    1,
    100,
  );
  expect(transport.setRoomReadiness).toHaveBeenNthCalledWith(
    2,
    room().code,
    'Ready',
    3,
    100,
  );
});

it('does not apply a start response for a song that was replaced while starting', async () => {
  const { transport, session } = setup();
  session.setSnapshot({ ...room(), songId: 'old', revision: 1 });
  const pending = deferred<RoomStateDto>();
  transport.roomControl.mockReturnValue(pending.promise);
  const playback = new RoomPlaybackCoordinator(session.getScope()!, transport);
  const start = playback.start();
  session.setSnapshot({ ...room(), songId: 'new', revision: 2 });
  pending.resolve({
    ...room(),
    songId: 'old',
    revision: 1,
    playbackState: 'playing',
  });
  await start;
  expect(session.getRoom()?.songId).toBe('new');
});
