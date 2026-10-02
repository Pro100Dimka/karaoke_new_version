import { describe, expect, it } from "vitest";

describe("room route statistics", () => {
  it("reports p95 route latency and deadline margin", async () => {
    const { summarizeRoute } = await import("./room-network-stats.mjs");
    const summary = summarizeRoute({
      samples: [8, 9, 10, 11, 12, 13, 14, 15, 16, 18],
      deadlineMs: 20,
    });
    expect(summary.p95Ms).toBe(18);
    expect(summary.deadlineMarginMs).toBe(2);
    expect(summary.samples).toBe(10);
  });
});
