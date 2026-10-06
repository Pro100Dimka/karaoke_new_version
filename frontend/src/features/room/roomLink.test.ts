import { describe, expect, it } from "vitest";
import type { RoomTimingReport } from "../../contracts/clients";
import { roomLink } from "./roomLink";

const report = (
  relayPackets: number,
  directPackets: number,
  lateCuts = 0,
  deviceStarvedFrames = 0,
): RoomTimingReport => ({
  roundTripMs: 40,
  deviceLatencyMs: 10,
  estimatedVoiceLatencyMs: 30,
  voiceDelayMs: 12,
  followMs: 0,
  packetsSent: 0,
  packetsReceived: 0,
  relayEchoes: 0,
  networkTransportRunning: true,
  networkSendEnabled: true,
  deviceStarvedFrames,
  remotes: {
    friend: {
      jitterMs: 1,
      targetDelayMs: 12,
      relayPackets,
      directPackets,
      lateCuts,
    },
  },
});

describe("roomLink", () => {
  it("names the route that delivered most voice since the earlier report", () => {
    expect(roomLink(report(100, 0), report(110, 4000)).route).toBe("direct");
    expect(roomLink(report(0, 100), report(4000, 110)).route).toBe("relay");
    expect(roomLink(undefined, report(0, 0)).route).toBeUndefined();
  });

  it("flags a stalling link only when more voice is cut than the room delay allows for", () => {
    expect(roomLink(report(0, 100, 3), report(0, 900, 3)).unstable).toBe(false);
    // 2 cuts in 800 packets (2.5 per thousand) are within the 0.5% the room delay accepts.
    expect(roomLink(report(0, 100, 3), report(0, 900, 5)).unstable).toBe(false);
    // 12 cuts in 800 packets (15 per thousand) are a stalling link.
    expect(roomLink(report(0, 100, 3), report(0, 900, 15)).unstable).toBe(true);
    expect(roomLink(undefined, report(0, 900, 15)).unstable).toBe(false);
  });

  it("flags a sound card that starves on this computer", () => {
    expect(
      roomLink(report(0, 100, 0, 480), report(0, 900, 0, 480)).deviceStarving,
    ).toBe(false);
    expect(
      roomLink(report(0, 100, 0, 480), report(0, 900, 0, 9_600)).deviceStarving,
    ).toBe(true);
  });
});
