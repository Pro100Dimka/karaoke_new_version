import { describe, expect, it } from "vitest";
import { runtimeConfigurationFromDiagnostics } from "./audioProtocol";

describe("runtime acoustic calibration", () => {
  it.each(["NaN", "Infinity", "-1", "500001"])("rejects invalid latency %s", value => {
    expect(runtimeConfigurationFromDiagnostics({ AcousticCalibrationValid: "1",
      AcousticLatencyUs: value }).calibratedLatencyMs).toBeUndefined();
  });

  it("requires native validity and preserves a verified zero", () => {
    expect(runtimeConfigurationFromDiagnostics({ AcousticCalibrationValid: "0",
      AcousticLatencyUs: "23000" }).calibratedLatencyMs).toBeUndefined();
    expect(runtimeConfigurationFromDiagnostics({ AcousticCalibrationValid: "1",
      AcousticLatencyUs: "0" }).calibratedLatencyMs).toBe(0);
  });
});
