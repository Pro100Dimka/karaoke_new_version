import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RoomStateDto } from "../../contracts/models";
import { useRoomVoicePolls } from "./useRoomVoicePolls";

const mocks = vi.hoisted(() => ({
  roomLevels: vi.fn(async () => []),
  roomTiming: vi.fn(async () => ({
    estimatedVoiceLatencyMs: 55,
    requestedVoiceDelayMs: 160,
    remotes: [],
  })),
  setRoomPlayoutDelay: vi.fn(async () => undefined),
  setVoiceLatency: vi.fn(),
}));

vi.mock("../../services/audioClient", () => ({
  audioClient: {
    roomLevels: mocks.roomLevels,
    roomTiming: mocks.roomTiming,
    setRoomPlayoutDelay: mocks.setRoomPlayoutDelay,
  },
}));
vi.mock("../../services/roomClient", () => ({
  roomClient: { setVoiceLatency: mocks.setVoiceLatency },
}));

afterEach(() => vi.clearAllMocks());

it("immediately applies the server-selected room deadline to AudioService", async () => {
  const initial = { code: "ROOM42", roomPlayoutDelayMs: 60, participants: [] } as unknown as RoomStateDto;
  const updated = { ...initial, roomPlayoutDelayMs: 160 };
  mocks.setVoiceLatency.mockResolvedValue(updated);
  const roomRef = { current: initial };

  const { unmount } = renderHook(() => useRoomVoicePolls("ROOM42", roomRef, vi.fn()));

  await waitFor(() => expect(mocks.setRoomPlayoutDelay).toHaveBeenCalledWith(160));
  expect(roomRef.current).toBe(updated);
  unmount();
});
