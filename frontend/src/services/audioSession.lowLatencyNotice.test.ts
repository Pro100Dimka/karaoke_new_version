import { describe, expect, it, vi } from "vitest";
import { onLowLatencyMicrophoneFallback, reportMicrophoneMode } from "./audioSession";

const diagnosticsReply = (lines: Record<string, string>) =>
  Object.assign(window, {
    desktop: {
      audioRequest: vi.fn(async () => ({
        status: 0,
        text: Object.entries(lines).map(([key, value]) => `${key}: ${value}`).join("\n"),
      })),
    },
  });

describe("minimum microphone latency notice", () => {
  it("tells once per opened stream set why the exclusive microphone was not used", async () => {
    const seen: unknown[] = [];
    const stop = onLowLatencyMicrophoneFallback((fallback) => seen.push(fallback));
    diagnosticsReply({ AcousticCalibrationContext: "7", LowLatencyMicrophoneRequested: "1",
      LowLatencyMicrophoneActive: "0", LowLatencyMicrophoneFallback: "DEVICE_IN_USE",
      InputUnavailableReason: "DEVICE_IN_USE" });
    await reportMicrophoneMode();
    await reportMicrophoneMode();
    expect(seen).toEqual([{ reason: "DEVICE_IN_USE", microphoneAvailable: false }]);
    diagnosticsReply({ AcousticCalibrationContext: "8", LowLatencyMicrophoneRequested: "1",
      LowLatencyMicrophoneActive: "1", LowLatencyMicrophoneFallback: "NONE" });
    await reportMicrophoneMode();
    expect(seen).toHaveLength(1);
    stop();
  });
});
