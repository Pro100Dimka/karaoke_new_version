import { renderHook } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { RoomDiagnosticsCoordinator } from "./RoomDiagnosticsCoordinator";
import type { RoomSessionScope } from "./RoomSessionController";

const mocks = vi.hoisted(() => ({
  diagnosticsDump: vi.fn(async (): Promise<Record<string, string>> => ({
    Backend: "ASIO",
    RoomCompensationFrames: "960",
  })),
  listDevices: vi.fn(async () => [
    { id: "mic-1", name: "Microphone Array", kind: "input", channels: 2 },
  ]),
  publishDiagnostics: vi.fn(async () => undefined),
  preferredConfiguration: vi.fn(() => ({
    backend: "WASAPI Exclusive",
    inputDeviceId: "mic-1",
    sampleRate: 0,
    periodFrames: 0,
  })),
}));
/** Exercises the application diagnostics publisher through a component lifetime. */
const useRoomDiagnosticsUpload = (code: string | undefined) => useEffect(() => {
  if (!code) return;
  let active = true;
  const scope = { code, generation: 1, signal: new AbortController().signal,
    isCurrent: () => active } as RoomSessionScope;
  const coordinator = new RoomDiagnosticsCoordinator(scope, {
    diagnosticsDump: mocks.diagnosticsDump,
    listDevices: mocks.listDevices,
    preferredConfiguration: mocks.preferredConfiguration,
  } as never, { publishDiagnostics: mocks.publishDiagnostics });
  coordinator.start({ backend: "WASAPI Exclusive" });
  return () => { active = false; coordinator.stop(); };
}, [code]);

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("uploads the audio diagnostics every few seconds while in a room and stops on leaving", async () => {
  vi.useFakeTimers();
  const { rerender } = renderHook(
    ({ code }) => useRoomDiagnosticsUpload(code),
    {
      initialProps: { code: "ROOM42" as string | undefined },
    },
  );
  await vi.advanceTimersByTimeAsync(10_000);
  expect(mocks.publishDiagnostics).toHaveBeenCalledTimes(2);
  expect(mocks.publishDiagnostics).toHaveBeenCalledWith("ROOM42", {
    Backend: "ASIO",
    RoomCompensationFrames: "960",
    "App.InputDevice": "Microphone Array",
    "App.OutputDevice": "default",
    "App.RequestedBackend": "WASAPI Exclusive",
    "App.PersistedBackend": "WASAPI Exclusive",
    "App.SettingsSelectedBackend": "WASAPI Exclusive",
    "App.HiddenLatencyMs": "unmeasured",
  });
  expect(mocks.listDevices).toHaveBeenCalledOnce();
  rerender({ code: undefined });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(mocks.publishDiagnostics).toHaveBeenCalledTimes(2);
});

it("reports the calibration applied by AudioService instead of an old saved value", async () => {
  mocks.diagnosticsDump.mockResolvedValueOnce({
    Backend: "ASIO",
    RoomCompensationFrames: "960",
    AcousticCalibrationValid: "1",
    AcousticLatencyUs: "32000",
  });
  vi.useFakeTimers();
  const { unmount } = renderHook(() => useRoomDiagnosticsUpload("ROOM42"));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(mocks.publishDiagnostics).toHaveBeenCalledWith(
    "ROOM42",
    expect.objectContaining({
      "App.HiddenLatencyMs": "32",
    }),
  );
  unmount();
});

it("preserves adjacent before and after stage counters when the physical backend changes", async () => {
  mocks.diagnosticsDump
    .mockResolvedValueOnce({
      Backend: "WASAPI Shared",
      generationId: "7",
      "RemoteDecodedNonzeroPackets.__room_server_mix__": "0",
      MasterOutputPeak: "0",
    })
    .mockResolvedValueOnce({
      Backend: "ASIO",
      generationId: "9",
      "RemoteDecodedNonzeroPackets.__room_server_mix__": "40",
      MasterOutputPeak: "0.25",
    });
  vi.useFakeTimers();
  const { unmount } = renderHook(() => useRoomDiagnosticsUpload("ROOM42"));

  await vi.advanceTimersByTimeAsync(10_000);

  expect(mocks.publishDiagnostics).toHaveBeenNthCalledWith(
    2,
    "ROOM42",
    expect.objectContaining({
      Backend: "WASAPI Shared",
      generationId: "7",
      "App.RequestedBackend": "WASAPI Exclusive",
      "App.PersistedBackend": "WASAPI Exclusive",
      "App.SettingsSelectedBackend": "WASAPI Exclusive",
      "App.BackendSwitchStage": "before",
      "App.BackendSwitchTo": "ASIO",
    }),
  );
  expect(mocks.publishDiagnostics).toHaveBeenNthCalledWith(
    3,
    "ROOM42",
    expect.objectContaining({
      Backend: "ASIO",
      generationId: "9",
      "App.BackendSwitchStage": "after",
      "App.BackendSwitchFrom": "WASAPI Shared",
    }),
  );
  unmount();
});
