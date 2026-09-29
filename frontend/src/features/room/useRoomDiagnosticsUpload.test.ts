import { renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useRoomDiagnosticsUpload } from "./useRoomDiagnosticsUpload";

const mocks = vi.hoisted(() => ({
  diagnosticsDump: vi.fn(async () => ({ Backend: "ASIO", RoomCompensationFrames: "960" })),
  publishDiagnostics: vi.fn(async () => undefined),
}));
vi.mock("../../services/audioClient", () => ({ audioClient: { diagnosticsDump: mocks.diagnosticsDump } }));
vi.mock("../../services/roomClient", () => ({ roomClient: { publishDiagnostics: mocks.publishDiagnostics } }));

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it("uploads the audio diagnostics every few seconds while in a room and stops on leaving", async () => {
  vi.useFakeTimers();
  const { rerender } = renderHook(({ code }) => useRoomDiagnosticsUpload(code), {
    initialProps: { code: "ROOM42" as string | undefined },
  });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(mocks.publishDiagnostics).toHaveBeenCalledTimes(2);
  expect(mocks.publishDiagnostics).toHaveBeenCalledWith("ROOM42", { Backend: "ASIO", RoomCompensationFrames: "960" });
  rerender({ code: undefined });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(mocks.publishDiagnostics).toHaveBeenCalledTimes(2);
});
