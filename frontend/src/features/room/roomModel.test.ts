import { describe, expect, it } from "vitest";
import type { ParticipantDto, RoomStateDto } from "../../contracts/models";
import { allConnectedReady, applySpeakingLevels, diffParticipants, localReadiness, playbackPlan, reconcileRemoteParticipants, sharedLibraryView } from "./roomModel";

const person = (id: string, patch: Partial<ParticipantDto> = {}): ParticipantDto => ({
  id,
  name: id,
  role: "participant",
  self: false,
  connected: true,
  muted: false,
  speakingLevel: 0,
  volume: 1,
  readiness: "ready",
  ...patch
});
const room = (participants: ParticipantDto[], patch: Partial<RoomStateDto> = {}): RoomStateDto => ({
  code: "ABC",
  hostId: "a",
  role: "host",
  participants,
  playbackLocked: false,
  ...patch
});

describe("room model", () => {
  it("gates the countdown on every connected participant being ready", () => {
    expect(allConnectedReady(room([person("a"), person("b")]))).toBe(true);
    expect(allConnectedReady(room([person("a"), person("b", { readiness: "downloading" })]))).toBe(false);
    expect(allConnectedReady(room([person("a"), person("b", { readiness: "failed", connected: false })]))).toBe(true);
  });

  it("detects who joined and who left between snapshots", () => {
    const change = diffParticipants(room([person("a"), person("b")]), room([person("a"), person("c")]));
    expect(change.joined.map(item => item.id)).toEqual(["c"]);
    expect(change.left.map(item => item.id)).toEqual(["b"]);
  });

  it("reports the exact revision as the only ready local state", () => {
    const target = room([person("a")], { songId: "s", revision: 2 });
    expect(localReadiness(target, [{ id: "s", status: "ready", activeRevision: 2 }])).toBe("Ready");
    expect(localReadiness(target, [{ id: "s", status: "ready", activeRevision: 1 }])).toBe("MissingSong");
    expect(localReadiness(target, [])).toBe("MissingSong");
    expect(localReadiness(target, [{ id: "local-s", status: "ready", activeRevision: 2 }], "local-s")).toBe("Ready");
  });

  it("registers peers already present in the initial room snapshot", () => {
    const target = room([person("self", { self: true }), person("host"), person("guest")]);

    expect(reconcileRemoteParticipants(new Set(), target)).toEqual({
      add: ["host", "guest"],
      remove: []
    });
  });

  it("removes departed peers without re-adding registered ones", () => {
    const target = room([person("self", { self: true }), person("host")]);

    expect(reconcileRemoteParticipants(new Set(["host", "gone"]), target)).toEqual({
      add: [],
      remove: ["gone"]
    });
  });

  it("applies local microphone and remote network levels to the matching participants", () => {
    const target = room([person("self", { self: true }), person("guest")]);

    expect(applySpeakingLevels(target, { local: 0.25, remote: { guest: 0.75 } }).participants)
      .toEqual([
        person("self", { self: true, speakingLevel: 0.25 }),
        person("guest", { speakingLevel: 0.75 })
      ]);
  });

  it("schedules a future authoritative room start", () => {
    const target = room([], {
      playbackState: "playing",
      playbackStartedAt: "2026-01-01T00:00:03Z",
      serverNow: "2026-01-01T00:00:00Z",
      playbackPositionSeconds: 0
    });

    expect(playbackPlan(target)).toEqual({ kind: "schedule", delayMilliseconds: 3000 });
  });

  it("seeks a late joiner to the current room position", () => {
    const target = room([], {
      playbackState: "playing",
      playbackStartedAt: "2026-01-01T00:00:00Z",
      serverNow: "2026-01-01T00:00:05Z",
      playbackPositionSeconds: 2
    });

    expect(playbackPlan(target)).toEqual({ kind: "play", positionSeconds: 7 });
  });

  it("reads the authoritative shared search and filters from a room snapshot", () => {
    expect(sharedLibraryView(room([], {
      libraryQuery: "Надія",
      libraryStatus: "ready",
      librarySort: "artist"
    }))).toEqual({ query: "Надія", status: "ready", sort: "artist" });
  });
});
