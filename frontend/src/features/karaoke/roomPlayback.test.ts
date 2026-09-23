import { describe, expect, it, vi } from "vitest";
import type { RoomStateDto } from "../../contracts/models";
import { roomPlaybackSnapshotKey, roomSelectionEnded, roomToggleCommand, roomPlaybackEvent, synchronizeRoomPlayback } from "./roomPlayback";

const room = (role: RoomStateDto["role"], playbackState: RoomStateDto["playbackState"]): RoomStateDto => ({
  code: "r", hostId: "h", role, participants: [], playbackLocked: playbackState === "playing", playbackState
});

describe("karaoke room playback controls", () => {
  it("lets only the host publish play and pause", () => {
    expect(roomToggleCommand(room("host", "stopped"))).toBe("Start");
    expect(roomToggleCommand(room("host", "playing"))).toBe("Pause");
    expect(roomToggleCommand(room("participant", "playing"))).toBeNull();
    expect(roomToggleCommand({ ...room("participant", "playing"), collaborativeControl: true })).toBe("Pause");
  });

  it("maps authoritative room playback to the local karaoke state machine", () => {
    expect(roomPlaybackEvent("playing", "ready")).toBe("PLAY");
    expect(roomPlaybackEvent("paused", "playing")).toBe("PAUSE");
    expect(roomPlaybackEvent("stopped", "playing")).toBe("FINISH");
    expect(roomPlaybackEvent("playing", "playing")).toBeNull();
  });

  it("finalizes the same local recording and analysis path when a room selection is cleared", () => {
    expect(roomSelectionEnded("RoomPrepared", undefined, "playing")).toBe(true);
    expect(roomSelectionEnded("RoomPrepared", undefined, "ready")).toBe(true);
    expect(roomSelectionEnded("Normal", undefined, "playing")).toBe(false);
    expect(roomSelectionEnded("RoomPrepared", "song", "playing")).toBe(false);
  });

  it("executes authoritative seek and play on the local AudioService", async () => {
    const audio = { seek: vi.fn(async () => undefined), play: vi.fn(async () => undefined), pause: vi.fn(async () => undefined) };
    const dispatch = vi.fn();
    await synchronizeRoomPlayback({
      ...room("participant", "playing"),
      playbackStartedAt: "2026-01-01T00:00:00Z",
      serverNow: "2026-01-01T00:00:00Z",
      playbackPositionSeconds: 12
    }, "ready", 0, audio, dispatch);

    expect(audio.seek).toHaveBeenCalledWith(12);
    expect(audio.play).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith("PLAY");
  });

  it("rechecks playback when a fresh server clock snapshot arrives", () => {
    const first = {
      ...room("participant", "playing"),
      playbackStartedAt: "2026-01-01T00:00:00Z",
      serverNow: "2026-01-01T00:00:05Z",
      serverClockOffsetMilliseconds: 100
    };
    const next = {
      ...first,
      serverNow: "2026-01-01T00:00:06Z",
      serverClockOffsetMilliseconds: 110
    };

    expect(roomPlaybackSnapshotKey(next)).not.toBe(roomPlaybackSnapshotKey(first));
  });

  it("corrects audible playback drift without reacting to tiny clock noise", async () => {
    const snapshot = {
      ...room("participant", "playing"),
      playbackStartedAt: "2026-01-01T00:00:00Z",
      serverNow: "2026-01-01T00:00:10Z",
      playbackPositionSeconds: 0
    };
    const audio = {
      seek: vi.fn(async () => undefined),
      play: vi.fn(async () => undefined),
      pause: vi.fn(async () => undefined)
    };

    await synchronizeRoomPlayback(snapshot, "playing", 9.88, audio, vi.fn());
    expect(audio.seek).toHaveBeenCalledWith(10);
    audio.seek.mockClear();
    await synchronizeRoomPlayback(snapshot, "playing", 9.96, audio, vi.fn());
    expect(audio.seek).not.toHaveBeenCalled();
  });
});
