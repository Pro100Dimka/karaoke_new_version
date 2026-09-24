import { describe, expect, it } from "vitest";
import type { RoomStateDto, SongDto } from "../../contracts/models";
import { roomKaraokeNavigation } from "./roomNavigation";

const room = (playbackState: RoomStateDto["playbackState"]): RoomStateDto => ({
  code: "room", hostId: "host", role: "participant", participants: [
    { id: "self", name: "Self", role: "participant", readiness: "ready", connected: true, muted: false, self: true, volume: 1, speakingLevel: 0 },
    { id: "friend", name: "Friend", role: "host", readiness: "ready", connected: true, muted: false, self: false, volume: 1, speakingLevel: 0 }
  ], playbackLocked: true,
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

  it("keeps every participant in the library until everyone has the selected project", () => {
    const waiting = {
      ...room("stopped"),
      participants: room("stopped").participants.map(person =>
        person.id === "friend" ? { ...person, readiness: "downloading" as const } : person
      )
    };

    expect(roomKaraokeNavigation(waiting, "/", [localSong(3)]))
      .toEqual({ kind: "stay" });
  });

  it("opens after the server Preparing state is mapped to the audio preparation phase", () => {
    const prepared = {
      ...room("stopped"),
      participants: room("stopped").participants.map(person => ({ ...person, readiness: "audio" as const })),
    };

    expect(roomKaraokeNavigation(prepared, "/", [localSong(3)]))
      .toEqual({ kind: "open", songId: "song", revision: 3 });
  });

  it("lets the karaoke lifecycle finalize recording and analysis when the host clears the room song", () => {
    const cleared = { ...room("stopped"), songId: undefined, revision: undefined };
    expect(roomKaraokeNavigation(cleared, "/karaoke/song", []))
      .toEqual({ kind: "stay" });
    expect(roomKaraokeNavigation(cleared, "/", []))
      .toEqual({ kind: "stay" });
  });

  it("does not reopen a completed room performance while analysis returns to the library", () => {
    expect(roomKaraokeNavigation(room("stopped"), "/", [localSong(3)], undefined, "song:3"))
      .toEqual({ kind: "stay" });
  });

  it("keeps an imported room project on its local id when the same song already existed", () => {
    const aliased = { ...localSong(3), id: "local-song" };
    expect(roomKaraokeNavigation(room("stopped"), "/", [aliased], "local-song"))
      .toEqual({ kind: "open", songId: "local-song", revision: 3 });
    expect(roomKaraokeNavigation(room("stopped"), "/karaoke/local-song", [aliased], "local-song"))
      .toEqual({ kind: "stay" });
  });
});
