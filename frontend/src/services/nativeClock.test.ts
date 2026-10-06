import { describe, expect, it } from "vitest";
import { acceptClockSample } from "./nativeClock";

describe("acceptClockSample", () => {
  it("maps the service clock at the middle of the round trip", () => {
    expect(acceptClockSample(undefined, 5_000_000_000, 100, 102)).toEqual({
      offset: 4899,
      roundTrip: 2,
      measuredAt: 102,
    });
  });
  it("keeps a fast sample over a later slow one, even minutes later", () => {
    const fast = acceptClockSample(undefined, 5_000_000_000, 100, 101);
    expect(acceptClockSample(fast, 5_120_000_000, 120_000, 120_010)).toBe(fast);
  });
  it("lets a comparable fresh sample replace an aged one", () => {
    const fast = acceptClockSample(undefined, 5_000_000_000, 100, 101);
    expect(
      acceptClockSample(fast, 5_120_000_000, 120_000, 120_002)?.measuredAt,
    ).toBe(120_002);
  });
  it("ignores a missing clock reading", () => {
    expect(acceptClockSample(undefined, Number.NaN, 0, 1)).toBeUndefined();
  });
});
