import { describe, expect, it } from "vitest";
import type { RoomStateDto } from "../../contracts/models";
import { roomToggleCommand, roomPlaybackEvent } from "./roomPlayback";

const room = (role: RoomStateDto["role"], playbackState: RoomStateDto["playbackState"]): RoomStateDto => ({
  code: "r", hostId: "h", role, participants: [], playbackLocked: playbackState === "playing", playbackState
});

describe("karaoke room playback controls", () => {
  it("lets only the host publish play and pause", () => {
    expect(roomToggleCommand(room("host", "stopped"))).toBe("Start");
    expect(roomToggleCommand(room("host", "playing"))).toBe("Pause");
    expect(roomToggleCommand(room("participant", "playing"))).toBeNull();
  });

  it("maps authoritative room playback to the local karaoke state machine", () => {
    expect(roomPlaybackEvent("playing", "ready")).toBe("PLAY");
    expect(roomPlaybackEvent("paused", "playing")).toBe("PAUSE");
    expect(roomPlaybackEvent("stopped", "playing")).toBe("FINISH");
    expect(roomPlaybackEvent("playing", "playing")).toBeNull();
  });
});
