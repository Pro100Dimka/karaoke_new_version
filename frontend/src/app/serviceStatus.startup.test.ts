import { describe, expect, it } from "vitest";
import { startupGraceMilliseconds, withStartupGrace } from "./serviceStatus";

describe("withStartupGrace", () => {
  it("reports a service that has never been ready as starting during the grace window", () => {
    expect(withStartupGrace({ kind: "unavailable" }, false, 1000)).toEqual({ kind: "starting" });
  });

  it("reports unavailable once the grace window has passed", () => {
    expect(withStartupGrace({ kind: "unavailable" }, false, startupGraceMilliseconds)).toEqual({ kind: "unavailable" });
  });

  it("reports an outage of a service that was ready before as unavailable immediately", () => {
    expect(withStartupGrace({ kind: "unavailable" }, true, 1000)).toEqual({ kind: "unavailable" });
  });

  it("never rewrites a ready or incompatible status", () => {
    expect(withStartupGrace({ kind: "ready", version: "1" }, false, 0)).toEqual({ kind: "ready", version: "1" });
    expect(withStartupGrace({ kind: "incompatible", version: "API 2", expected: "API 1" }, false, 0).kind).toBe("incompatible");
  });
});
