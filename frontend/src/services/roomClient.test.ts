import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { roomClient } from "./roomClient";
import { participantId } from "./roomMappers";

describe("roomClient", () => {
  afterEach(() => vi.restoreAllMocks());
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
      librarySort: "artist",
      playbackRate: 0.9,
      keyShift: -2
    });

    expect(roomRequest).toHaveBeenCalledWith(expect.objectContaining({
      path: "/rooms/room-1/shared-state",
      body: expect.objectContaining({
        radioEnabled: true,
        radioStationId: "groove-salad",
        libraryQuery: "Надія",
        libraryStatus: "ready",
        librarySort: "artist",
        playbackRate: 0.9,
        keyShift: -2
      })
    }));
  });

  it("falls back to the legacy shared-state schema while an older room server is being upgraded", async () => {
    roomRequest
      .mockResolvedValueOnce({ status: 422, ok: false, body: { code: "Http422" } })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        body: {
          roomId: "ROOM-1", hostId: "host-1", participants: [], playbackState: "Stopped",
          playbackPositionSeconds: 0, serverNow: new Date().toISOString()
        }
      });

    await roomClient.updateSharedState("ROOM-1", {
      radioEnabled: true,
      radioStationId: "groove-salad",
      libraryQuery: "query",
      libraryStatus: "all",
      librarySort: "recent",
      playbackRate: 0.9,
      keyShift: 2
    });

    expect(roomRequest).toHaveBeenCalledTimes(2);
    expect(roomRequest.mock.calls[1]?.[0].body).not.toHaveProperty("playbackRate");
    expect(roomRequest.mock.calls[1]?.[0].body).not.toHaveProperty("keyShift");
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

  it("sends explicit host moderation commands to the room server", async () => {
    await roomClient.transferHost("ROOM-1", "guest");
    await roomClient.removeParticipant("ROOM-1", "late-guest");
    await roomClient.closeRoom("ROOM-1");

    expect(roomRequest.mock.calls.map(([request]) => request.path)).toEqual([
      "/rooms/room-1/host",
      "/rooms/room-1/participants/late-guest/remove",
      "/rooms/room-1/close"
    ]);
    expect(roomRequest.mock.calls[0]?.[0].body).toEqual({
      participantId,
      targetParticipantId: "guest"
    });
  });

  it("receives room snapshots through a server-held change subscription", async () => {
    const room = {
      roomId: "ROOM-1", hostId: participantId, songId: null, revision: null,
      participants: [], playbackState: "Stopped", playbackStartedAt: null,
      playbackPositionSeconds: 0, serverNow: new Date().toISOString()
    };
    roomRequest
      .mockResolvedValueOnce({ status: 200, ok: true, body: { version: 4, room } })
      .mockImplementationOnce(() => new Promise(() => undefined));
    const listener = vi.fn();

    const unsubscribe = roomClient.watchRoom("ROOM-1", listener, vi.fn());
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ code: "ROOM-1" })
    ));
    unsubscribe();

    expect(roomRequest).toHaveBeenCalledWith(expect.objectContaining({
      path: expect.stringContaining("/rooms/room-1/changes?participantId=")
    }));
  });

  it("does not treat the server-held wait as network clock latency", async () => {
    const room = {
      roomId: "ROOM-1", hostId: participantId, songId: null, revision: null,
      participants: [], playbackState: "Stopped", playbackStartedAt: null,
      playbackPositionSeconds: 0, serverNow: "2026-09-24T10:00:00.000Z"
    };
    roomRequest
      .mockResolvedValueOnce({ status: 200, ok: true, body: { version: 1, room } })
      .mockImplementationOnce(() => new Promise(() => undefined));
    const listener = vi.fn();

    const unsubscribe = roomClient.watchRoom("ROOM-1", listener, vi.fn());
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
    unsubscribe();

    expect(listener.mock.calls[0]?.[0].serverClockOffsetMilliseconds).toBeUndefined();
  });

  it("retains a monotonic clock estimate across server-held snapshots", async () => {
    const now = Date.parse("2026-09-24T10:00:00Z");
    const room = {
      roomId: "clock-room", hostId: participantId, songId: null, revision: null,
      participants: [], playbackState: "Stopped", playbackStartedAt: null,
      playbackPositionSeconds: 0, serverNow: new Date(now).toISOString(),
    };
    vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(140).mockReturnValue(30000);
    roomRequest.mockResolvedValueOnce({ status: 200, ok: true, body: room });
    const calibrated = await roomClient.getRoom("clock-room");
    expect(calibrated.serverClockOffsetMilliseconds).toBe(now - 120);
    roomRequest
      .mockResolvedValueOnce({ status: 200, ok: true, body: { version: 1, room } })
      .mockImplementationOnce(() => new Promise(() => undefined));
    const listener = vi.fn();
    const unsubscribe = roomClient.watchRoom("clock-room", listener, vi.fn());
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
    unsubscribe();
    expect(listener.mock.calls[0]?.[0].serverClockOffsetMilliseconds).toBe(now - 120);
  });

  it("keeps the lower round-trip clock sample when another request is slow", async () => {
    const now = Date.parse("2026-09-24T10:00:00Z");
    const room = {
      roomId: "clock-samples", hostId: participantId, participants: [], playbackState: "Stopped",
      playbackPositionSeconds: 0, serverNow: new Date(now).toISOString(),
    };
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(100).mockReturnValueOnce(140)
      .mockReturnValueOnce(200).mockReturnValueOnce(400);
    roomRequest.mockResolvedValueOnce({ status: 200, ok: true, body: room });
    await roomClient.getRoom("clock-samples");
    roomRequest.mockResolvedValueOnce({ status: 200, ok: true,
      body: { ...room, serverNow: new Date(now + 200).toISOString() } });
    expect((await roomClient.getRoom("clock-samples")).serverClockOffsetMilliseconds).toBe(now - 120);
  });
});
