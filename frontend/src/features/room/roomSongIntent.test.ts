import { describe, expect, it } from "vitest";
import type { RoomStateDto } from "../../contracts/models";
import { roomSongPlayIntent } from "./roomSongIntent";

const room = (role: RoomStateDto["role"]): RoomStateDto => ({
  code: "room",
  hostId: "host",
  role,
  participants: [],
  playbackLocked: true,
  playbackState: "stopped",
});

describe("room song play intent", () => {
  it("turns the host play button into one authoritative room selection", () => {
    expect(roomSongPlayIntent(room("host"))).toBe("select-room");
  });

  it("does not let a participant start a divergent local karaoke", () => {
    expect(roomSongPlayIntent(room("participant"))).toBe("wait-for-host");
    expect(roomSongPlayIntent({ ...room("participant"), collaborativeControl: true })).toBe("select-room");
  });

  it("keeps ordinary local playback outside a room", () => {
    expect(roomSongPlayIntent(null)).toBe("play-local");
  });
});
