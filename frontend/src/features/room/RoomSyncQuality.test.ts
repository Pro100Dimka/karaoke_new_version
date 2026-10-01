import { describe, expect, it } from "vitest";
import type { RoomTimingReport } from "../../contracts/clients";
import { roomQualityMessage } from "./RoomSyncQuality";

const timing = (voiceDelayMs: number, followMs = 0): RoomTimingReport => ({
  roundTripMs: 0,
  deviceLatencyMs: 0,
  deviceStarvedFrames: 0,
  remotes: {},
  estimatedVoiceLatencyMs: 0,
  voiceDelayMs,
  followMs,
});

describe("roomQualityMessage", () => {
  it("calls a small delay one room for everyone", () => {
    expect(roomQualityMessage(timing(22))).toBe("roomQualityClose");
  });
  it("identifies the common server delay instead of naming a human leader", () => {
    expect(roomQualityMessage({ ...timing(160), roomPlayoutDelayMs: 160 }))
      .toBe("roomQualitySynchronized");
    expect(roomQualityMessage(timing(60))).toBe("roomQualityNoticeable");
  });
  it("warns about a delay that no mode can hide", () => {
    expect(roomQualityMessage(timing(140, 140))).toBe("roomQualityFar");
  });
});
