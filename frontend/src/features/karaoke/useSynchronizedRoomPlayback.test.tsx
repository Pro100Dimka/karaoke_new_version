import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { synchronizeRoomPlayback } from "./roomPlayback";
import { useSynchronizedRoomPlayback } from "./useSynchronizedRoomPlayback";

vi.mock("./roomPlayback", () => ({
  roomPlaybackSnapshotKey: vi.fn(() => "snapshot-1"),
  synchronizeRoomPlayback: vi.fn(),
}));

describe("synchronized room playback hook", () => {
  it("applies a pushed room snapshot and emits the local state transition", async () => {
    vi.mocked(synchronizeRoomPlayback).mockImplementation(async (_room, _state, _position, _audio, emit) => {
      emit("PLAY");
      return undefined;
    });
    const onEvent = vi.fn();
    const room = {
      code: "room", hostId: "host", role: "participant", participants: [], playbackLocked: true,
      playbackState: "playing", playbackStartedAt: "2026-09-24T10:00:00Z", playbackPositionSeconds: 2,
      serverNow: "2026-09-24T10:00:02Z",
    } as never;

    renderHook(() => useSynchronizedRoomPlayback({
      room, ready: true, stateKind: "ready", position: { current: 0 },
      onEvent, onFinished: vi.fn(), onFailure: vi.fn(),
    }));

    await waitFor(() => expect(onEvent).toHaveBeenCalledWith("PLAY"));
  });
});
