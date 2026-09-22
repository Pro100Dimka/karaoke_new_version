import { describe, expect, it } from "vitest";
import type { RoomSongDto, SongDto } from "../../contracts/models";
import { mergeRoomLibrary, pendingRoomProjects } from "./roomLibrary";

const local = (id: string, revision = 1): SongDto => ({
  id, title: "Local", artist: "Me", language: "Auto", status: "ready",
  durationSeconds: 120, createdAt: "2026-01-01T00:00:00Z", coverState: "Fallback",
  activeRevision: revision, projectFormatVersion: 1
});

const remote = (ownerParticipantId: string, songId: string, revision = 1): RoomSongDto => ({
  ownerParticipantId, songId, revision, title: "Shared", artist: "Friend", durationSeconds: 180
});

describe("shared room library", () => {
  it("adds another participant's ready songs and keeps an exact local copy local", () => {
    const result = mergeRoomLibrary([local("same"), local("older", 1)], [
      remote("friend", "same"),
      remote("friend", "older", 2),
      remote("friend", "remote-only", 3)
    ], "self");

    expect(result.find(song => song.id === "same")?.roomOwnerId).toBeUndefined();
    expect(result.find(song => song.id === "older")?.roomOwnerId).toBe("friend");
    expect(result.find(song => song.id === "remote-only")).toMatchObject({
      title: "Shared", status: "ready", activeRevision: 3, roomOwnerId: "friend"
    });
  });

  it("does not duplicate the current participant's published songs", () => {
    expect(mergeRoomLibrary([local("mine")], [remote("self", "mine")], "self")).toHaveLength(1);
  });

  it("keeps failed project uploads pending while skipping successful revisions", () => {
    const songs = [local("uploaded"), local("retry")];
    expect(pendingRoomProjects("room", songs, new Set(["room:uploaded:1"])).map(song => song.id))
      .toEqual(["retry"]);
  });
});
