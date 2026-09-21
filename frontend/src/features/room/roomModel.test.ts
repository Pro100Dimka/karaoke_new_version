import { describe, expect, it } from "vitest";
import type { ParticipantDto, RoomStateDto } from "../../contracts/models";
import { allConnectedReady, diffParticipants, localReadiness } from "./roomModel";

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
  });
});
