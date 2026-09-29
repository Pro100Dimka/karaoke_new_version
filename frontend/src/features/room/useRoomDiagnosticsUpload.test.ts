import { renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useRoomDiagnosticsUpload } from "./useRoomDiagnosticsUpload";

const mocks = vi.hoisted(() => ({
  diagnosticsDump: vi.fn(async () => ({ Backend: "ASIO", RoomCompensationFrames: "960" })),
  listDevices: vi.fn(async () => [{ id: "mic-1", name: "Microphone Array", kind: "input", channels: 2 }]),
  publishDiagnostics: vi.fn(async () => undefined),
}));
vi.mock("../../services/audioClient", () => ({
  audioClient: { diagnosticsDump: mocks.diagnosticsDump, listDevices: mocks.listDevices },
}));
vi.mock("../../app/AppContext", () => ({
  useApp: () => ({ preferences: {
    audio: { backend: "WASAPI Exclusive", inputDeviceId: "mic-1", periodFrames: 480, sampleRate: 0 },
    acousticLatencyMs: { "WASAPI Exclusive|mic-1||480": 57 },
  } }),
}));
vi.mock("../../services/roomClient", () => ({ roomClient: { publishDiagnostics: mocks.publishDiagnostics } }));

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it("uploads the audio diagnostics every few seconds while in a room and stops on leaving", async () => {
  vi.useFakeTimers();
  const { rerender } = renderHook(({ code }) => useRoomDiagnosticsUpload(code), {
    initialProps: { code: "ROOM42" as string | undefined },
  });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(mocks.publishDiagnostics).toHaveBeenCalledTimes(2);
  expect(mocks.publishDiagnostics).toHaveBeenCalledWith("ROOM42", {
    Backend: "ASIO", RoomCompensationFrames: "960", "App.InputDevice": "Microphone Array",
    "App.OutputDevice": "default", "App.RequestedBackend": "WASAPI Exclusive", "App.HiddenLatencyMs": "57",
  });
  expect(mocks.listDevices).toHaveBeenCalledOnce();
  rerender({ code: undefined });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(mocks.publishDiagnostics).toHaveBeenCalledTimes(2);
});
