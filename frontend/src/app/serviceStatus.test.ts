import { describe, expect, it } from "vitest";
import { pythonStatusFrom, reconnected } from "./serviceStatus";

describe("service status", () => {
  it("flags an incompatible API version explicitly", () => {
    expect(pythonStatusFrom({ status: "ready", version: "9", apiVersion: 2 }).kind).toBe("incompatible");
  });

  it("only reports a reconnect after a real outage, not the first successful probe", () => {
    expect(reconnected({ kind: "starting" }, { kind: "ready", version: "1" })).toBe(false);
    expect(reconnected({ kind: "unavailable" }, { kind: "ready", version: "1" })).toBe(true);
  });
});
