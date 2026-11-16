
import { useEffect } from 'react';
import { afterEach, vi } from 'vitest';
import type { RoomTimingReport } from '../../contracts/clients';
import type { RoomStateDto } from '../../contracts/models';

import { RoomVoiceCoordinator } from './RoomVoiceCoordinator';
import type { RoomSessionScope } from './RoomSessionController';
const mocks = vi.hoisted(() => ({
  roomLevels: vi.fn(async () => ({ local: 0, remote: {} })),
  voiceLevels: vi.fn(async () => ({})),
  roomTiming: vi.fn(async (): Promise<Partial<RoomTimingReport>> => ({
    estimatedVoiceLatencyMs: 55,
    requestedVoiceDelayMs: 160,
    packetsSent: 0,
    packetsReceived: 0,
    relayEchoes: 0,
    networkTransportRunning: false,
    networkSendEnabled: false,
    remotes: {},
  })),
  setRoomPlayoutDelay: vi.fn(async () => undefined),
  reconnectVoiceSession: vi.fn(async () => undefined),
  setVoiceLatency: vi.fn(),
  microphoneEnabled: vi.fn(() => true),
  setMicrophoneEnabled: vi.fn(async () => undefined),
}));
const useRoomVoicePolls = (
  code: string | undefined,
  roomRef: { current: RoomStateDto | null },
  setRoom: (room: RoomStateDto) => void,
) =>
  useEffect(() => {
    if (!code) return;
    let active = true;
    const scope: RoomSessionScope = {
      code,
      generation: 1,
      signal: new AbortController().signal,
      isCurrent: () => active && roomRef.current?.code === code,
      getRoom: () => (active ? roomRef.current : null),
      setSnapshot: (snapshot) => {
        if (!active || roomRef.current?.code !== code) return false;
        roomRef.current = snapshot;
        setRoom(snapshot);
        return true;
      },
      disconnect: () => {
        active = false;
        return true;
      },
    };
    const voice = new RoomVoiceCoordinator(
      scope,
      {
        roomLevels: mocks.roomLevels,
        roomTiming: mocks.roomTiming,
        setRoomPlayoutDelay: mocks.setRoomPlayoutDelay,
        reconnectVoiceSession: mocks.reconnectVoiceSession,
        microphoneEnabled: mocks.microphoneEnabled,
        setMicrophoneEnabled: mocks.setMicrophoneEnabled,
      } as never,
      'self',
    );
    voice.startPolls({
      voiceLevels: mocks.voiceLevels,
      setVoiceLatency: mocks.setVoiceLatency,
    } as never);
    return () => {
      active = false;
      voice.stop();
    };
  }, [code, roomRef, setRoom]);
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  Reflect.deleteProperty(window, 'desktop');
});
export { useRoomVoicePolls };

export const roomVoicePollingFixtureState = { mocks };
