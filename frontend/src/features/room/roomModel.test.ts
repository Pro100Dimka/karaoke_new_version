import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParticipantDto, RoomStateDto } from "../../contracts/models";
import { allConnectedReady, applySpeakingLevels, diffParticipants, encodeSharedLibraryView, hasCurrentParticipant, localReadiness, playbackPlan, reconcileRemoteParticipants, restoreRoomVoiceAfterReconnect, sharedLibraryView } from "./roomModel";

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
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it("detects when this client has been removed from an otherwise existing room", () => {
    expect(hasCurrentParticipant(room([person("self", { self: true }), person("host")]))).toBe(true);
    expect(hasCurrentParticipant(room([person("host"), person("guest")]))).toBe(false);
  });

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

    expect(playbackPlan(target)).toEqual({ kind: "schedule", delayMilliseconds: 3000, positionSeconds: 0 });
  });

  it("keeps every singer on the same media timeline regardless of voice route latency", () => {
    const participants = [
      person("fast", { self: true, voiceLatencyMs: 20 }),
      person("slow", { voiceLatencyMs: 80 }),
    ];
    const target = room(participants, {
      playbackState: "playing",
      playbackStartedAt: "2026-01-01T00:00:03Z",
      serverNow: "2026-01-01T00:00:00Z",
      playbackPositionSeconds: 0,
    });

    expect(playbackPlan(target)).toEqual({ kind: "schedule", delayMilliseconds: 3000, positionSeconds: 0 });
    expect(playbackPlan({ ...target, playbackState: "paused", playbackPositionSeconds: 12 }))
      .toEqual({ kind: "pause", positionSeconds: 12 });
    expect(playbackPlan(room([
      person("fast", { voiceLatencyMs: 20 }),
      person("slow", { self: true, voiceLatencyMs: 80 }),
    ], {
      playbackState: "playing",
      playbackStartedAt: "2026-01-01T00:00:03Z",
      serverNow: "2026-01-01T00:00:00Z",
      playbackPositionSeconds: 0,
    }))).toEqual({ kind: "schedule", delayMilliseconds: 3000, positionSeconds: 0 });
  });

  it("restores voice registration after the room server connection returns", () => {
    const self = person("self", { self: true });

    expect(restoreRoomVoiceAfterReconnect(
      room([self], { connectionStatus: "reconnecting" }),
      room([self], { connectionStatus: "connected" }),
    )).toBe(true);
    expect(restoreRoomVoiceAfterReconnect(
      room([self], { connectionStatus: "connected" }),
      room([self], { connectionStatus: "connected" }),
    )).toBe(false);
  });

  it("removes response transit time from the authoritative countdown", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2025-12-31T23:59:59.150Z");
    vi.spyOn(performance, "now").mockReturnValue(150);
    const target = room([], {
      playbackState: "playing",
      playbackStartedAt: "2026-01-01T00:00:03Z",
      serverNow: "2026-01-01T00:00:00Z",
      playbackPositionSeconds: 0,
      serverClockOffsetMilliseconds: Date.parse("2026-01-01T00:00:00Z")
    } as Partial<RoomStateDto>);

    expect(playbackPlan(target)).toEqual({ kind: "schedule", delayMilliseconds: 2850, positionSeconds: 0 });
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

  it.each([0.5, 1.5])("advances the room source position at tempo %s", playbackRate => {
    const target = room([], {
      playbackState: "playing", playbackRate, playbackPositionSeconds: 2,
      playbackStartedAt: "2026-01-01T00:00:00Z", serverNow: "2026-01-01T00:00:10Z",
    });
    expect(playbackPlan(target)).toEqual({ kind: "play", positionSeconds: 2 + 10 * playbackRate });
  });

  it("reads the authoritative shared search and filters from a room snapshot", () => {
    expect(sharedLibraryView(room([], {
      libraryQuery: "Надія",
      libraryStatus: "ready",
      librarySort: "artist"
    }))).toEqual({
      query: "Надія",
      status: "ready",
      language: "all",
      duration: "all",
      artwork: "all",
      sort: "artist",
      direction: "desc",
    });
  });

  it("round-trips expanded library filters through the compact room state", () => {
    const encoded = encodeSharedLibraryView({
      status: "ready", language: "English", duration: "short", artwork: "with", sort: "bpm", direction: "asc",
    });
    expect(sharedLibraryView(room([], encoded))).toMatchObject({
      status: "ready", language: "English", duration: "short", artwork: "with", sort: "bpm", direction: "asc",
    });
  });
});
