import { describe, expect, it } from "vitest";
import { buildDiagnosticsReport } from "./diagnosticsReport";

describe("buildDiagnosticsReport", () => {
  it("marks unavailable subsystems explicitly instead of hiding them", () => {
    const report = JSON.parse(
      buildDiagnosticsReport({
        frontendVersion: "1.0.0",
        generatedAt: "2026-01-01T00:00:00Z",
        backend: null,
        audio: { ServiceState: "Running" },
        keyboardLighting: false
      })
    ) as Record<string, unknown>;

    expect(report.pythonBackend).toBe("unavailable");
    expect(report.audioService).toEqual({ ServiceState: "Running" });
    expect(report.keyboardLighting).toContain("unsupported");
  });
});
