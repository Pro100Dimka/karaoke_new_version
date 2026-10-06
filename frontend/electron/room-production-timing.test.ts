import { describe, expect, it } from "vitest";

describe("production room timing input", () => {
  it("uses the measured round route instead of the 60 ms default", async () => {
    const { measuredVoiceLatencyMs } =
      await import("./room-production-timing.mjs");
    expect(
      measuredVoiceLatencyMs({ upstreamP95Ms: 14, downstreamP95Ms: 20 }),
    ).toBe(34);
  });
});
