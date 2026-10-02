import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RoomStateDto } from "../../contracts/models";
import { useRoomVoicePolls } from "./useRoomVoicePolls";

const mocks = vi.hoisted(() => ({
  roomLevels: vi.fn(async () => ({ local: 0, remote: {} })),
  voiceLevels: vi.fn(async () => ({})),
  roomTiming: vi.fn(async () => ({
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
}));

vi.mock("../../services/audioClient", () => ({
  audioClient: {
    roomLevels: mocks.roomLevels,
    roomTiming: mocks.roomTiming,
    setRoomPlayoutDelay: mocks.setRoomPlayoutDelay,
    reconnectVoiceSession: mocks.reconnectVoiceSession,
  },
}));
vi.mock("../../services/roomClient", () => ({
  roomClient: { setVoiceLatency: mocks.setVoiceLatency, voiceLevels: mocks.voiceLevels },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("shows the server-reported microphone level on each remote participant", async () => {
  mocks.roomLevels.mockResolvedValueOnce({ local: 0.25, remote: { __room_server_mix__: 0.9 } });
  mocks.voiceLevels.mockResolvedValueOnce({ guest: 0.75 });
  const initial = {
    code: "ROOM42",
    participants: [
      { id: "self", self: true, speakingLevel: 0 },
      { id: "guest", self: false, speakingLevel: 0 },
    ],
  } as unknown as RoomStateDto;
  const roomRef = { current: initial };
  const setRoom = vi.fn();

  const { unmount } = renderHook(() => useRoomVoicePolls("ROOM42", roomRef, setRoom));

  await waitFor(() => expect(setRoom).toHaveBeenCalled());
  expect(roomRef.current.participants.map(({ id, speakingLevel }) => ({ id, speakingLevel })))
    .toEqual([
      { id: "self", speakingLevel: 0.25 },
      { id: "guest", speakingLevel: 0.75 },
    ]);
  unmount();
});

it("does not declare voice timing ready before the relay has answered", async () => {
  const roomRef = {
    current: { code: "ROOM42", roomPlayoutDelayMs: 10, participants: [] } as unknown as RoomStateDto,
  };

  const { unmount } = renderHook(() => useRoomVoicePolls("ROOM42", roomRef, vi.fn()));

  await waitFor(() => expect(mocks.roomTiming).toHaveBeenCalled());
  expect(mocks.setVoiceLatency).not.toHaveBeenCalled();
  unmount();
});

it("immediately applies the server-selected room deadline to AudioService", async () => {
  mocks.roomTiming.mockResolvedValueOnce({
    estimatedVoiceLatencyMs: 55,
    requestedVoiceDelayMs: 160,
    packetsSent: 10,
    packetsReceived: 10,
    relayEchoes: 1,
    networkTransportRunning: true,
    networkSendEnabled: true,
    remotes: {},
  });
  const initial = { code: "ROOM42", roomPlayoutDelayMs: 60, participants: [] } as unknown as RoomStateDto;
  const updated = { ...initial, roomPlayoutDelayMs: 160 };
  mocks.setVoiceLatency.mockResolvedValue(updated);
  const roomRef = { current: initial };

  const { unmount } = renderHook(() => useRoomVoicePolls("ROOM42", roomRef, vi.fn()));

  await waitFor(() => expect(mocks.setRoomPlayoutDelay).toHaveBeenCalledWith(160));
  expect(roomRef.current).toEqual(updated);
  unmount();
});

it("re-registers voice when microphone packets continue but relay echoes stop", async () => {
  vi.useFakeTimers();
  let packetsSent = 10;
  mocks.roomTiming.mockImplementation(async () => ({
    estimatedVoiceLatencyMs: 55,
    requestedVoiceDelayMs: 80,
    packetsSent: packetsSent++,
    packetsReceived: 4,
    relayEchoes: 4,
    networkTransportRunning: true,
    networkSendEnabled: true,
    remotes: {},
  }));
  mocks.setVoiceLatency.mockResolvedValue({
    code: "ROOM42", roomPlayoutDelayMs: 80, participants: [],
  } as unknown as RoomStateDto);
  const roomRef = {
    current: { code: "ROOM42", roomPlayoutDelayMs: 80, participants: [] } as unknown as RoomStateDto,
  };

  const { unmount } = renderHook(() => useRoomVoicePolls("ROOM42", roomRef, vi.fn()));
  await act(async () => { await Promise.resolve(); });
  for (let sample = 0; sample < 4; sample += 1) {
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
  }

  expect(mocks.reconnectVoiceSession).toHaveBeenCalledTimes(1);
  unmount();
  vi.useRealTimers();
});

it("keeps a healthy voice session when relay echoes continue", async () => {
  vi.useFakeTimers();
  let sample = 0;
  mocks.roomTiming.mockImplementation(async () => ({
    estimatedVoiceLatencyMs: 55,
    requestedVoiceDelayMs: 80,
    packetsSent: 10 + sample,
    packetsReceived: 4 + sample,
    relayEchoes: 4 + sample++,
    networkTransportRunning: true,
    networkSendEnabled: true,
    remotes: {},
  }));
  mocks.setVoiceLatency.mockResolvedValue({
    code: "ROOM42", roomPlayoutDelayMs: 80, participants: [],
  } as unknown as RoomStateDto);
  const roomRef = {
    current: { code: "ROOM42", roomPlayoutDelayMs: 80, participants: [] } as unknown as RoomStateDto,
  };

  const { unmount } = renderHook(() => useRoomVoicePolls("ROOM42", roomRef, vi.fn()));
  await act(async () => { await Promise.resolve(); });
  for (let tick = 0; tick < 4; tick += 1) {
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
  }

  expect(mocks.reconnectVoiceSession).not.toHaveBeenCalled();
  unmount();
  vi.useRealTimers();
});
