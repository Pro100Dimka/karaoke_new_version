import { expect, it, vi } from 'vitest';
import type { RoomStateDto } from '../../contracts/models';
import type { RoomSessionScope } from './RoomSessionController';
import { RoomVoiceCoordinator } from './RoomVoiceCoordinator';

const snapshot = (
  status: 'connected' | 'reconnecting' = 'connected',
): RoomStateDto => ({
  code: 'room-a',
  hostId: 'host',
  role: 'participant',
  playbackLocked: false,
  connectionStatus: status,
  roomPlayoutDelayMs: 84,
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
    {
      id: 'remote',
      name: 'Remote',
      role: 'host',
      self: false,
      connected: true,
      readiness: 'ready',
      muted: false,
      volume: 1,
    },
  ],
});
const setup = () => {
  let active = true;
  const scope: RoomSessionScope = {
    code: 'room-a',
    generation: 1,
    signal: new AbortController().signal,
    isCurrent: () => active,
    getRoom: () => (active ? snapshot() : null),
    setSnapshot: () => active,
    disconnect: () => {
      active = false;
      return true;
    },
  };
  const audio = {
    joinVoiceSession: vi.fn(async () => undefined),
    synchronizeRoomClock: vi.fn(async () => undefined),
    setRoomPlayoutDelay: vi.fn(async () => undefined),
    addRemoteParticipant: vi.fn(async (): Promise<void> => undefined),
    removeRemoteParticipant: vi.fn(async () => undefined),
    playTestSound: vi.fn(async () => undefined),
    roomLevels: vi.fn(async () => ({ local: 0, remote: {} })),
    roomTiming: vi.fn(async () => ({
      roundTripMs: 0,
      deviceLatencyMs: 0,
      packetsSent: 0,
      packetsReceived: 0,
      relayEchoes: 0,
      networkTransportRunning: false,
      networkSendEnabled: false,
      remotes: {},
      estimatedVoiceLatencyMs: 0,
      voiceDelayMs: 0,
      followMs: 0,
      deviceStarvedFrames: 0,
    })),
    reconnectVoiceSession: vi.fn(async () => undefined),
    microphoneEnabled: vi.fn(() => true),
    setMicrophoneEnabled: vi.fn(async () => undefined),
    participantMuted: vi.fn(() => false),
    participantVolume: vi.fn(() => 1),
    setParticipantMuted: vi.fn(async () => undefined),
    setParticipantVolume: vi.fn(async () => undefined),
    setParticipantEffect: vi.fn(async () => undefined),
    monitoringEnabled: vi.fn(() => false),
    snapshot: vi.fn(async () => ({ monitoring: false }) as never),
    setMonitoring: vi.fn(async () => ({ monitoring: true }) as never),
  };
  return {
    scope,
    audio,
    voice: new RoomVoiceCoordinator(scope, audio, 'self'),
    invalidate: () => {
      active = false;
    },
  };
};

it('reads the retained audio gain rather than the default room snapshot volume', () => {
  const { voice, audio } = setup();
  audio.participantVolume.mockReturnValue(0.37);
  expect(voice.participantVolume('remote')).toBe(0.37);
  expect(audio.participantVolume).toHaveBeenCalledWith('remote');
});

it('re-registers voice once after reconnect and keeps personal controls scoped to that session', async () => {
  const { voice, audio, invalidate } = setup();
  const before = snapshot('reconnecting');
  const after = { ...snapshot(), serverClockOffsetMilliseconds: 50 };
  await voice.synchronize(before, after);
  await voice.synchronize(after, after);

  expect(audio.joinVoiceSession).toHaveBeenCalledOnce();
  expect(audio.joinVoiceSession).toHaveBeenCalledWith('room-a', 'self', 50);
  expect(audio.setRoomPlayoutDelay.mock.invocationCallOrder[0]).toBeLessThan(
    audio.joinVoiceSession.mock.invocationCallOrder[0] ?? -Infinity,
  );
  expect(audio.synchronizeRoomClock).toHaveBeenLastCalledWith(50);
  expect(audio.setRoomPlayoutDelay).toHaveBeenLastCalledWith(84);
  expect(audio.addRemoteParticipant).toHaveBeenCalledOnce();
  audio.setMicrophoneEnabled.mockClear();
  await voice.setParticipantMuted('remote', true);
  expect(audio.setParticipantMuted).toHaveBeenLastCalledWith('remote', true);
  await voice.setParticipantMuted('remote', false);
  expect(audio.setParticipantMuted).toHaveBeenLastCalledWith('remote', false);
  expect(audio.setMicrophoneEnabled).not.toHaveBeenCalled();
  await voice.setParticipantEffect('remote', 'reverb', 0.3);
  expect(audio.setParticipantEffect).toHaveBeenLastCalledWith('remote', 'reverb', 0.3);
  invalidate();
  audio.setParticipantMuted.mockClear();
  audio.setParticipantEffect.mockClear();
  await voice.setParticipantMuted('remote', true);
  await voice.setParticipantEffect('remote', 'reverb', 0.5);
  expect(audio.setParticipantMuted).not.toHaveBeenCalled();
  expect(audio.setParticipantEffect).not.toHaveBeenCalled();
});

it('reconnects a voice transport that disappeared with the native process', async () => {
  vi.useFakeTimers();
  const { voice, audio } = setup();
  const room = {
    voiceLevels: vi.fn(async () => ({})),
    setVoiceLatency: vi.fn(async () => snapshot()),
  };
  try {
    voice.startPolls(room);
    await vi.advanceTimersByTimeAsync(0);
    expect(audio.reconnectVoiceSession).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4000);
    expect(audio.reconnectVoiceSession).toHaveBeenCalledOnce();
    voice.stop();
    await vi.advanceTimersByTimeAsync(6000);
    expect(audio.reconnectVoiceSession).toHaveBeenCalledOnce();
  } finally {
    voice.stop();
    vi.useRealTimers();
  }
});

it('ignores a late remote registration after the session is invalidated', async () => {
  const { voice, audio, invalidate } = setup();
  let complete!: () => void;
  audio.addRemoteParticipant.mockReturnValue(
    new Promise<void>((resolve) => {
      complete = resolve;
    }),
  );
  const syncing = voice.synchronize(snapshot(), snapshot());
  await vi.waitFor(() =>
    expect(audio.addRemoteParticipant).toHaveBeenCalledOnce(),
  );
  invalidate();
  complete();
  await syncing;
  expect(voice.registeredParticipants()).toEqual([]);
});
