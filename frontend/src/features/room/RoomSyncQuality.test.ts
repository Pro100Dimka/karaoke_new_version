import { describe, expect, it } from "vitest";
import type { RoomTimingReport } from "../../contracts/clients";
import { roomQualityMessage } from "./RoomSyncQuality";

const timing = (voiceDelayMs: number, followMs = 0): RoomTimingReport => ({
  roundTripMs: 0, deviceLatencyMs: 0, remotes: {}, estimatedVoiceLatencyMs: 0, voiceDelayMs, followMs,
});

describe("roomQualityMessage", () => {
  it("calls a small delay one room for everyone", () => {
    expect(roomQualityMessage(timing(22))).toBe("roomQualityClose");
  });
  it("tells a follower it sings on the leader's beat and anyone else how late the others are", () => {
    expect(roomQualityMessage(timing(60, 60))).toBe("roomQualityFollower");
    expect(roomQualityMessage(timing(60))).toBe("roomQualityNoticeable");
  });
  it("warns about a delay that no mode can hide", () => {
    expect(roomQualityMessage(timing(140, 140))).toBe("roomQualityFar");
  });
});
