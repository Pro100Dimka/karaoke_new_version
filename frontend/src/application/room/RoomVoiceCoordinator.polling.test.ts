import { act, renderHook, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { RoomTimingReport } from "../../contracts/clients";
import type { RoomStateDto } from "../../contracts/models";
import { speakingLevelOf } from "./roomSpeakingLevelsStore";
import { RoomVoiceCoordinator } from "./RoomVoiceCoordinator";
import type { RoomSessionScope } from "./RoomSessionController";

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

/** The old hook scenarios now drive the application voice coordinator through a local lease. */
const useRoomVoicePolls = (
  code: string | undefined,
  roomRef: { current: RoomStateDto | null },
  setRoom: (room: RoomStateDto) => void,
) => useEffect(() => {
  if (!code) return;
  let active = true;
  const scope: RoomSessionScope = {
    code, generation: 1, signal: new AbortController().signal,
    isCurrent: () => active && roomRef.current?.code === code,
    getRoom: () => active ? roomRef.current : null,
    setSnapshot: (snapshot) => {
      if (!active || roomRef.current?.code !== code) return false;
      roomRef.current = snapshot;
      setRoom(snapshot);
      return true;
    },
    disconnect: () => { active = false; return true; },
  };
  const voice = new RoomVoiceCoordinator(scope, {
    roomLevels: mocks.roomLevels,
    roomTiming: mocks.roomTiming,
    setRoomPlayoutDelay: mocks.setRoomPlayoutDelay,
    reconnectVoiceSession: mocks.reconnectVoiceSession,
    microphoneEnabled: mocks.microphoneEnabled,
    setMicrophoneEnabled: mocks.setMicrophoneEnabled,
  } as never, "self");
  voice.startPolls({ voiceLevels: mocks.voiceLevels,
    setVoiceLatency: mocks.setVoiceLatency } as never);
  return () => { active = false; voice.stop(); };
}, [code, roomRef, setRoom]);

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  Reflect.deleteProperty(window, "desktop");
});

it("shows the server-reported microphone level on each remote participant without touching the room", async () => {
  mocks.roomLevels.mockResolvedValueOnce({
    local: 0.25,
    remote: { __room_server_mix__: 0.9 },
  });
  mocks.voiceLevels.mockResolvedValueOnce({ guest: 0.75 });
  const initial = {
    code: "ROOM42",
    participants: [],
  } as unknown as RoomStateDto;
  const roomRef = { current: initial };
  const setRoom = vi.fn();

  const { unmount } = renderHook(() =>
    useRoomVoicePolls("ROOM42", roomRef, setRoom),
  );

  await waitFor(() =>
    expect(speakingLevelOf({ id: "guest", self: false })).toBe(0.75),
  );
  expect(speakingLevelOf({ id: "self", self: true })).toBe(0.25);
  // The meters repaint on their own; the room (and every screen reading it) is left alone.
  expect(setRoom).not.toHaveBeenCalled();
  expect(roomRef.current).toBe(initial);
  unmount();
  expect(speakingLevelOf({ id: "guest", self: false })).toBe(0);
});

it("refreshes the locally cached pushed levels smoothly", async () => {
  vi.useFakeTimers();
  const roomRef = {
    current: { code: "ROOM42", participants: [] } as unknown as RoomStateDto,
  };

  const { unmount } = renderHook(() =>
    useRoomVoicePolls("ROOM42", roomRef, vi.fn()),
  );
  await act(async () => {
    await Promise.resolve();
  });
  mocks.voiceLevels.mockClear();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });

  expect(mocks.voiceLevels).toHaveBeenCalledTimes(12);
  unmount();
});

it("does not declare voice timing ready before the relay has answered", async () => {
  const roomRef = {
    current: {
      code: "ROOM42",
      roomPlayoutDelayMs: 10,
      participants: [],
    } as unknown as RoomStateDto,
  };

  const { unmount } = renderHook(() =>
    useRoomVoicePolls("ROOM42", roomRef, vi.fn()),
  );

  await waitFor(() => expect(mocks.roomTiming).toHaveBeenCalled());
  expect(mocks.setVoiceLatency).not.toHaveBeenCalled();
  unmount();
});

it("keeps the safe initial deadline until the physical route has a stable packet window", async () => {
  mocks.roomTiming.mockResolvedValueOnce({
    estimatedVoiceLatencyMs: 12,
    requestedVoiceDelayMs: 12,
    packetsSent: 100,
    packetsReceived: 100,
    relayEchoes: 4,
    networkTransportRunning: true,
    networkSendEnabled: true,
    remotes: {},
  });
  const roomRef = {
    current: {
      code: "ROOM42",
      roomPlayoutDelayMs: 80,
      participants: [],
    } as unknown as RoomStateDto,
  };

  const { unmount } = renderHook(() =>
    useRoomVoicePolls("ROOM42", roomRef, vi.fn()),
  );

  await waitFor(() => expect(mocks.roomTiming).toHaveBeenCalled());
  expect(mocks.setVoiceLatency).not.toHaveBeenCalled();
  unmount();
});

it("publishes the first route from probe echoes before any server mix can arrive", async () => {
  mocks.roomTiming.mockResolvedValueOnce({
    estimatedVoiceLatencyMs: 47,
    requestedVoiceDelayMs: 6,
    packetsSent: 1_000,
    packetsReceived: 0,
    relayEchoes: 2,
    networkTransportRunning: true,
    networkSendEnabled: true,
    remotes: {},
  });
  const room = {
    code: "ROOM42",
    roomPlayoutDelayMs: 80,
    participants: [],
  } as unknown as RoomStateDto;
  mocks.setVoiceLatency.mockResolvedValue(room);

  const { unmount } = renderHook(() =>
    useRoomVoicePolls("ROOM42", { current: room }, vi.fn()),
  );

  await waitFor(() =>
    expect(mocks.setVoiceLatency).toHaveBeenCalledWith("ROOM42", 47, undefined, false),
  );
  unmount();
});

it("immediately applies the server-selected room deadline to AudioService", async () => {
  mocks.roomTiming.mockResolvedValueOnce({
    estimatedVoiceLatencyMs: 55,
    requestedVoiceDelayMs: 160,
    packetsSent: 1_000,
    packetsReceived: 1_000,
    relayEchoes: 1,
    networkTransportRunning: true,
    networkSendEnabled: true,
    remotes: {},
  });
  const initial = {
    code: "ROOM42",
    roomPlayoutDelayMs: 60,
    participants: [],
  } as unknown as RoomStateDto;
  const updated = { ...initial, roomPlayoutDelayMs: 160 };
  mocks.setVoiceLatency.mockResolvedValue(updated);
  const roomRef = { current: initial };

  const { unmount } = renderHook(() =>
    useRoomVoicePolls("ROOM42", roomRef, vi.fn()),
  );

  await waitFor(() =>
    expect(mocks.setRoomPlayoutDelay).toHaveBeenCalledWith(160),
  );
  expect(roomRef.current).toEqual(updated);
  unmount();
});

it("publishes the measured p99 arrival requirement when recurring transport stalls exceed RTT/2", async () => {
  mocks.roomTiming.mockResolvedValueOnce({
    estimatedVoiceLatencyMs: 55,
    requestedVoiceDelayMs: 147,
    packetsSent: 1_000,
    packetsReceived: 1_000,
    relayEchoes: 1,
    networkTransportRunning: true,
    networkSendEnabled: true,
    remotes: {},
  });
  const room = {
    code: "ROOM42",
    roomPlayoutDelayMs: 60,
    participants: [],
  } as unknown as RoomStateDto;
  mocks.setVoiceLatency.mockResolvedValue(room);

  const { unmount } = renderHook(() =>
    useRoomVoicePolls("ROOM42", { current: room }, vi.fn()),
  );

  await waitFor(() =>
    expect(mocks.setVoiceLatency).toHaveBeenCalledWith(
      "ROOM42",
      147,
      undefined,
      true,
    ),
  );
  expect(mocks.setVoiceLatency).not.toHaveBeenCalledWith(
    "ROOM42",
    55,
    undefined,
    true,
  );
  unmount();
});

it("allows the explicit Electron room E2E harness to publish its diagnostic delay", async () => {
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: { roomE2e: true },
  });
  mocks.roomTiming.mockResolvedValueOnce({
    estimatedVoiceLatencyMs: 55,
    requestedVoiceDelayMs: 160,
    packetsSent: 1_000,
    packetsReceived: 1_000,
    relayEchoes: 1,
    networkTransportRunning: true,
    networkSendEnabled: true,
    remotes: {},
  });
  const room = {
    code: "ROOM42",
    roomPlayoutDelayMs: 80,
    participants: [],
  } as unknown as RoomStateDto;
  mocks.setVoiceLatency.mockResolvedValue(room);

  const { unmount } = renderHook(() =>
    useRoomVoicePolls("ROOM42", { current: room }, vi.fn()),
  );

  await waitFor(() =>
    expect(mocks.setVoiceLatency).toHaveBeenCalledWith(
      "ROOM42",
      160,
      undefined,
      true,
    ),
  );
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
    code: "ROOM42",
    roomPlayoutDelayMs: 80,
    participants: [],
  } as unknown as RoomStateDto);
  const roomRef = {
    current: {
      code: "ROOM42",
      roomPlayoutDelayMs: 80,
      participants: [],
    } as unknown as RoomStateDto,
  };

  const { unmount } = renderHook(() =>
    useRoomVoicePolls("ROOM42", roomRef, vi.fn()),
  );
  await act(async () => {
    await Promise.resolve();
  });
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
    code: "ROOM42",
    roomPlayoutDelayMs: 80,
    participants: [],
  } as unknown as RoomStateDto);
  const roomRef = {
    current: {
      code: "ROOM42",
      roomPlayoutDelayMs: 80,
      participants: [],
    } as unknown as RoomStateDto,
  };

  const { unmount } = renderHook(() =>
    useRoomVoicePolls("ROOM42", roomRef, vi.fn()),
  );
  await act(async () => {
    await Promise.resolve();
  });
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

it("publishes the calibrated return and arrival stages with the route so the server can size its deadline", async () => {
  mocks.roomTiming.mockResolvedValueOnce({
    estimatedVoiceLatencyMs: 20,
    requestedVoiceDelayMs: 31.24,
    returnRequirementMs: 4.26,
    arrivalRequirementMs: 12.04,
    packetsSent: 1_000,
    packetsReceived: 1_000,
    relayEchoes: 1,
    networkTransportRunning: true,
    networkSendEnabled: true,
    remotes: {},
  });
  const room = {
    code: "ROOM42",
    roomPlayoutDelayMs: 80,
    participants: [],
  } as unknown as RoomStateDto;
  mocks.setVoiceLatency.mockResolvedValue({
    ...room,
    roomPlayoutDelayMs: 32.5,
  });

  const { unmount } = renderHook(() =>
    useRoomVoicePolls("ROOM42", { current: room }, vi.fn()),
  );

  await waitFor(() =>
    expect(mocks.setVoiceLatency).toHaveBeenCalledWith("ROOM42", 31.2, {
      returnRequirementMs: 4.3,
      arrivalRequirementMs: 12,
    }, true),
  );
  unmount();
});
