import { describe, expect, it } from "vitest";
import type { RoomTimingReport } from "../../contracts/clients";
import { roomLink } from "./roomLink";

const report = (relayPackets: number, directPackets: number, lateCuts = 0): RoomTimingReport => ({
  roundTripMs: 40, deviceLatencyMs: 10, estimatedVoiceLatencyMs: 30, voiceDelayMs: 12, followMs: 0,
  remotes: { friend: { jitterMs: 1, targetDelayMs: 12, relayPackets, directPackets, lateCuts } },
});

describe("roomLink", () => {
  it("names the route that delivered most voice since the earlier report", () => {
    expect(roomLink(report(100, 0), report(110, 4000)).route).toBe("direct");
    expect(roomLink(report(0, 100), report(4000, 110)).route).toBe("relay");
    expect(roomLink(undefined, report(0, 0)).route).toBeUndefined();
  });

  it("flags a stalling link only when voice was cut since the earlier report", () => {
    expect(roomLink(report(0, 100, 3), report(0, 900, 3)).unstable).toBe(false);
    expect(roomLink(report(0, 100, 3), report(0, 900, 5)).unstable).toBe(true);
    expect(roomLink(undefined, report(0, 900, 5)).unstable).toBe(false);
  });
});
