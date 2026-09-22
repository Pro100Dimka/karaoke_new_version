import { describe, expect, it } from "vitest";
import type { RoomStateDto, SongDto } from "../../contracts/models";
import { roomKaraokeNavigation } from "./roomNavigation";

const room = (playbackState: RoomStateDto["playbackState"]): RoomStateDto => ({
  code: "room", hostId: "host", role: "participant", participants: [], playbackLocked: true,
  songId: "song", revision: 3, playbackState
});
const localSong = (revision: number): SongDto => ({
  id: "song", title: "Song", artist: "Artist", language: "Auto", status: "ready",
  durationSeconds: 120, createdAt: "2026-01-01T00:00:00Z", coverState: "Fallback",
  activeRevision: revision, projectFormatVersion: 1
});

describe("room karaoke navigation", () => {
  it("downloads a missing selected revision before moving a participant into the playing room", () => {
    expect(roomKaraokeNavigation(room("playing"), "/", [localSong(2)]))
      .toEqual({ kind: "download", songId: "song", revision: 3 });
  });

  it("opens the exact local project and does not reopen an already matching karaoke route", () => {
    expect(roomKaraokeNavigation(room("playing"), "/", [localSong(3)]))
      .toEqual({ kind: "open", songId: "song", revision: 3 });
    expect(roomKaraokeNavigation(room("playing"), "/karaoke/song", [localSong(3)]))
      .toEqual({ kind: "stay" });
  });

  it("prepares the shared karaoke scene as soon as the host selects a song, before playback starts", () => {
    expect(roomKaraokeNavigation(room("stopped"), "/", []))
      .toEqual({ kind: "download", songId: "song", revision: 3 });
  });
});
