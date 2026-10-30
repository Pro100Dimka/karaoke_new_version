import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SubsystemHealth } from "../useSubsystemHealth";
import { useDiagnosticsActions } from "./useDiagnosticsActions";

const services = vi.hoisted(() => ({
  backend: { listJobs: vi.fn() },
  desktop: {
    keyboardLightingCapabilities: vi.fn(),
    copyText: vi.fn<(text: string) => Promise<void>>(),
    saveTextFile: vi.fn<(name: string, text: string) => Promise<boolean>>(),
  },
  notify: vi.fn(),
}));
vi.mock("../../../../../../services/pythonClient", () => ({ pythonClient: services.backend }));
vi.mock("../../../../../../services/desktopClient", () => ({ desktopClient: services.desktop }));

vi.mock("../../../../../../providers/notifications", () => ({
  useNotify: () => services.notify,
}));

const health: SubsystemHealth = {
  loading: false,
  backend: null,
  audio: { ServiceState: "Running", XRuns: "0" },
  audioVersion: "1",
  refresh: vi.fn(),
};

beforeEach(() => {
  services.backend.listJobs.mockReset().mockResolvedValue([]);
  services.desktop.keyboardLightingCapabilities
    .mockReset()
    .mockResolvedValue({ available: false, deviceCount: 0 });
  services.desktop.copyText.mockReset().mockResolvedValue(undefined);
  services.desktop.saveTextFile.mockReset().mockResolvedValue(true);
  services.notify.mockReset();
});
afterEach(cleanup);

it("reads jobs on demand and delivers the current diagnostics through both desktop actions", async () => {
  const { result, rerender } = renderHook(useDiagnosticsActions, {
    initialProps: health,
  });
  await act(async () => {});
  expect(services.backend.listJobs).not.toHaveBeenCalled();
  await act(async () => result.current.deliverReport("file"));
  expect(services.desktop.saveTextFile).toHaveBeenCalledWith(
    "ad-voice-diagnostics.json",
    expect.any(String),
  );
  expect(
    JSON.parse(services.desktop.saveTextFile.mock.calls[0]![1]),
  ).toMatchObject({
    audioService: health.audio,
    failedProcessing: [],
  });
  expect(services.notify).toHaveBeenCalledWith("Отчёт экспортирован", "success");

  rerender({ ...health, audio: { ServiceState: "Failed" } });
  await act(async () => result.current.deliverReport("clipboard"));
  expect(JSON.parse(services.desktop.copyText.mock.calls[0]![0])).toMatchObject({
    audioService: { ServiceState: "Failed" },
  });
  expect(services.backend.listJobs).toHaveBeenCalledTimes(2);
  expect(services.notify).toHaveBeenCalledWith("Скопировано", "success");
});

it("reports copy and export failures instead of dropping rejected promises", async () => {
  services.desktop.copyText.mockRejectedValueOnce(
    new Error("clipboard blocked"),
  );
  services.desktop.saveTextFile.mockRejectedValueOnce(new Error("disk full"));
  const { result } = renderHook(() => useDiagnosticsActions(health));

  await act(async () => result.current.deliverReport("clipboard"));
  expect(services.notify).toHaveBeenCalledWith("clipboard blocked", "error");
  await act(async () => result.current.deliverReport("file"));
  expect(services.notify).toHaveBeenCalledWith("disk full", "error");
  expect(services.notify).not.toHaveBeenCalledWith("Скопировано", "success");
  expect(services.notify).not.toHaveBeenCalledWith("Отчёт экспортирован", "success");
});

it("can export without job data and does not report a cancelled save as success", async () => {
  services.backend.listJobs.mockRejectedValueOnce(
    new Error("jobs unavailable"),
  );
  services.desktop.saveTextFile.mockResolvedValueOnce(false);
  const { result } = renderHook(() => useDiagnosticsActions(health));

  await act(async () => result.current.deliverReport("file"));
  expect(
    JSON.parse(services.desktop.saveTextFile.mock.calls[0]![1]),
  ).toMatchObject({
    failedProcessing: "unavailable",
  });
  expect(services.notify).not.toHaveBeenCalled();
});
