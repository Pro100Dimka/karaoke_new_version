import { expect, it, vi } from "vitest";
import type { RoomStateDto } from "../../contracts/models";
import type { RoomSessionScope } from "./RoomSessionController";
import { RoomVoiceCoordinator } from "./RoomVoiceCoordinator";

const snapshot = (status: "connected" | "reconnecting" = "connected"): RoomStateDto => ({
  code: "room-a", hostId: "host", role: "participant", playbackLocked: false,
  connectionStatus: status, roomPlayoutDelayMs: 84,
  participants: [
    { id: "self", name: "Self", role: "participant", self: true,
      connected: true, readiness: "ready", muted: false, volume: 1 },
    { id: "remote", name: "Remote", role: "host", self: false,
      connected: true, readiness: "ready", muted: false, volume: 1 },
  ],
});
const setup = () => {
  let active = true;
  const scope: RoomSessionScope = {
    code: "room-a", generation: 1, signal: new AbortController().signal,
    isCurrent: () => active, getRoom: () => active ? snapshot() : null,
    setSnapshot: () => active, disconnect: () => { active = false; return true; },
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
      roundTripMs: 0, deviceLatencyMs: 0, packetsSent: 0, packetsReceived: 0,
      relayEchoes: 0, networkTransportRunning: false, networkSendEnabled: false,
      remotes: {}, estimatedVoiceLatencyMs: 0, voiceDelayMs: 0, followMs: 0,
      deviceStarvedFrames: 0,
    })),
    reconnectVoiceSession: vi.fn(async () => undefined),
    microphoneEnabled: vi.fn(() => true), setMicrophoneEnabled: vi.fn(async () => undefined),
    participantMuted: vi.fn(() => false), setParticipantMuted: vi.fn(async () => undefined),
    setParticipantVolume: vi.fn(async () => undefined),
    setParticipantEffect: vi.fn(async () => undefined),
    monitoringEnabled: vi.fn(() => false),
    snapshot: vi.fn(async () => ({ monitoring: false } as never)),
    setMonitoring: vi.fn(async () => ({ monitoring: true } as never)),
  };
  return { scope, audio, voice: new RoomVoiceCoordinator(scope, audio, "self"),
    invalidate: () => { active = false; } };
};

it("re-registers voice once after reconnect and applies server clock and deadline", async () => {
  const { voice, audio } = setup();
  const before = snapshot("reconnecting");
  const after = { ...snapshot(), serverClockOffsetMilliseconds: 50 };
  await voice.synchronize(before, after);
  await voice.synchronize(after, after);

  expect(audio.joinVoiceSession).toHaveBeenCalledOnce();
  expect(audio.joinVoiceSession).toHaveBeenCalledWith("room-a", "self", 50);
  expect(audio.setRoomPlayoutDelay.mock.invocationCallOrder[0]!).toBeLessThan(
    audio.joinVoiceSession.mock.invocationCallOrder[0]!,
  );
  expect(audio.synchronizeRoomClock).toHaveBeenLastCalledWith(50);
  expect(audio.setRoomPlayoutDelay).toHaveBeenLastCalledWith(84);
  expect(audio.addRemoteParticipant).toHaveBeenCalledOnce();
});

it("ignores a late remote registration after the session is invalidated", async () => {
  const { voice, audio, invalidate } = setup();
  let complete!: () => void;
  audio.addRemoteParticipant.mockReturnValue(new Promise<void>((resolve) => { complete = resolve; }));
  const syncing = voice.synchronize(snapshot(), snapshot());
  await vi.waitFor(() => expect(audio.addRemoteParticipant).toHaveBeenCalledOnce());
  invalidate();
  complete();
  await syncing;
  expect(voice.registeredParticipants()).toEqual([]);
});
