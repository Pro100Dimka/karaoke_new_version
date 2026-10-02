import { describe, expect, it } from "vitest";
import { classifyRoomE2eFailure } from "./room-e2e-classification.mjs";

describe("classifyRoomE2eFailure", () => {
  it("distinguishes a missing pilot from a deadline miss", () => {
    expect(classifyRoomE2eFailure({
      audioAlignment: { backingSkewMs: 0, remoteVocalSkewMs: null },
      relayMetrics: { nonzero_recipient_packets: 12 },
      routes: { deadlineMarginMs: 1 },
      processReports: [{ packetsSent: 100, packetsReceived: 100, lateAudioCuts: 0 }],
    })).toBe("PILOT_NOT_DETECTED");
    expect(classifyRoomE2eFailure({
      audioAlignment: { backingSkewMs: 0, remoteVocalSkewMs: 1 },
      relayMetrics: { nonzero_recipient_packets: 12 },
      routes: { deadlineMarginMs: -1 },
      processReports: [{ packetsSent: 100, packetsReceived: 100, lateAudioCuts: 2 }],
    })).toBe("NETWORK_DEADLINE_MISS");
    expect(classifyRoomE2eFailure({
      audioAlignment: { backingSkewMs: 0, remoteVocalSkewMs: 1 },
      relayMetrics: { nonzero_recipient_packets: 12 },
      routes: { deadlineMarginMs: 1 },
      processReports: [{ packetsSent: 100, packetsReceived: 100, lateAudioCuts: 2 }],
      lateCutPhases: [{ firstPhase: "DRAIN", lastPhase: "DRAIN", lateAudioCuts: 2 }],
    })).toBe("DRAIN_LIFECYCLE");
    expect(classifyRoomE2eFailure({
      audioAlignment: { backingSkewMs: 0, remoteVocalSkewMs: 1 },
      relayMetrics: {
        nonzero_recipient_packets: 14,
        max_inputs_seen: 1,
        max_expected_mixers: 2,
        ingress_nonzero_packets: 8000,
      },
      routes: { deadlineMarginMs: 16 },
      processReports: [{ packetsSent: 100, packetsReceived: 100, lateAudioCuts: 0 }],
    })).toBe("MUSICAL_POSITION_MISMATCH");
    expect(classifyRoomE2eFailure({
      audioAlignment: { backingSkewMs: 0, remoteVocalSkewMs: 0 },
      relayMetrics: {
        nonzero_recipient_packets: 12,
        positions: 2000,
        pending_lifecycle: { complete_nonempty_positions: 6 },
      },
      routes: { deadlineMarginMs: 16 },
      processReports: [{ packetsSent: 100, packetsReceived: 100, lateAudioCuts: 0 }],
    })).toBe("SERVER_MIX_INCOMPLETE");
    expect(classifyRoomE2eFailure({
      audioAlignment: { backingSkewMs: 0, remoteVocalSkewMs: 0 },
      relayMetrics: {
        nonzero_recipient_packets: 12,
        pending_lifecycle: { created_positions: 2000, complete_nonempty_positions: 6 },
      },
      routes: { deadlineMarginMs: 16 },
      processReports: [{ packetsSent: 100, packetsReceived: 100, lateAudioCuts: 2 }],
      lateCutPhases: [{ firstPhase: "DRAIN", lastPhase: "DRAIN", lateAudioCuts: 2 }],
    })).toBe("SERVER_MIX_INCOMPLETE");
  });
});
