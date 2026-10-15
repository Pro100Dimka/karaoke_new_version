import { describe, expect, it } from "vitest";
import { endpointArgs } from "./audioSession";

describe("minimum microphone latency request", () => {
  it("asks AudioService for an exclusive microphone only for Windows", () => {
    expect(endpointArgs({ backend: "WASAPI Shared", sampleRate: 0, periodFrames: 0, lowLatencyInput: true }))
      .toMatchObject({ backend: "wasapi-shared", lowLatencyInput: 1 });
    expect(endpointArgs({ backend: "WASAPI Shared", sampleRate: 0, periodFrames: 0 }))
      .not.toHaveProperty("lowLatencyInput");
    expect(endpointArgs({ backend: "ASIO", sampleRate: 0, periodFrames: 0, lowLatencyInput: true }))
      .not.toHaveProperty("lowLatencyInput");
  });
});
