import { beforeEach, describe, expect, it, vi } from "vitest";
import { roomClient } from "./roomClient";
import { participantId } from "./roomMappers";

describe("roomClient", () => {
  let roomRequest: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    roomRequest = vi.fn(async () => ({
      status: 200,
      ok: true,
      body: {
        roomId: "0976f70a-988b-412f-aa12-d9229228632e",
        hostId: "host-1",
        songId: null,
        revision: null,
        participants: [],
        playbackState: "Stopped",
        playbackStartedAt: null,
        playbackPositionSeconds: 0,
        serverNow: new Date().toISOString()
      }
    }));
    Object.assign(window, { desktop: { roomRequest } });
  });

  it("sends an uppercase pasted UUID in the canonical lowercase form", async () => {
    await roomClient.joinRoom("0976F70A-988B-412F-AA12-D9229228632E", "Guest");

    expect(roomRequest).toHaveBeenCalledWith(expect.objectContaining({
      path: "/rooms/0976f70a-988b-412f-aa12-d9229228632e/join"
    }));
  });

  it("publishes radio, search and filter state through the room snapshot", async () => {
    await roomClient.updateSharedState("ROOM-1", {
      radioEnabled: true,
      radioStationId: "groove-salad",
      libraryQuery: "Надія",
      libraryStatus: "ready",
      librarySort: "artist"
    });

    expect(roomRequest).toHaveBeenCalledWith(expect.objectContaining({
      path: "/rooms/room-1/shared-state",
      body: expect.objectContaining({
        radioEnabled: true,
        radioStationId: "groove-salad",
        libraryQuery: "Надія",
        libraryStatus: "ready",
        librarySort: "artist"
      })
    }));
  });

  it("sends the authoritative seek position with a room control", async () => {
    await roomClient.roomControl("ROOM-1", "Seek", 42.5);

    expect(roomRequest).toHaveBeenCalledWith(expect.objectContaining({
      path: "/rooms/room-1/control",
      body: expect.objectContaining({ command: "Seek", positionSeconds: 42.5 })
    }));
  });

  it("clears the selected room song when the host leaves karaoke", async () => {
    await roomClient.clearRoomSong("ROOM-1");

    expect(roomRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: "POST",
      path: "/rooms/room-1/song/clear",
      body: expect.objectContaining({ participantId })
    }));
  });

  it("publishes the local ready library to the shared room", async () => {
    await roomClient.publishLibrary("ROOM-1", [{
      id: "song-1",
      title: "Song",
      artist: "Artist",
      language: "Auto",
      status: "ready",
      durationSeconds: 120,
      createdAt: "2026-01-01T00:00:00Z",
      coverState: "Fallback",
      activeRevision: 2,
      projectFormatVersion: 1
    }]);

    expect(roomRequest).toHaveBeenCalledWith(expect.objectContaining({
      path: "/rooms/room-1/library",
      body: expect.objectContaining({
        songs: [expect.objectContaining({ songId: "song-1", revision: 2, title: "Song" })]
      })
    }));
  });
});
