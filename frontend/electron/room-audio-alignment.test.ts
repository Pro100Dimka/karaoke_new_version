import { describe, expect, it } from "vitest";

describe("room audio alignment", () => {
  it("finds the sample offset between two rendered signals", async () => {
    const { estimateOffsetMs } = await import("./room-audio-alignment.mjs");
    const source = Array.from({ length: 200 }, (_, index) => Math.sin(index / 7));
    const delayed = [...Array(4).fill(0), ...source.slice(0, -4)];
    expect(estimateOffsetMs(source, delayed, 1000).offsetMs).toBe(4);
  });
});
