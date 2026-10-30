import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceDto } from "../../../../../contracts/models";
import { useAsioSetup } from "./useAsioSetup";

const calls = vi.hoisted(() => ({
  install: vi.fn(async () => undefined),
  relaunch: vi.fn(async () => undefined),
  listDevices: vi.fn(async (): Promise<readonly DeviceDto[]> => []),
}));
vi.mock("../../../../../services/audioClient", () => ({ audioClient: { listDevices: calls.listDevices } }));
vi.mock("../../../../../services/desktopClient", () => ({ desktopClient: {
  installAsio4All: calls.install, relaunchApp: calls.relaunch,
} }));

const driver: DeviceDto = {
  id: "asio4all",
  name: "ASIO4ALL v2",
  backend: "ASIO",
  kind: "output",
  channels: 2,
};

describe("ASIO installation lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    calls.install.mockReset().mockResolvedValue(undefined);
    calls.relaunch.mockReset().mockResolvedValue(undefined);
    calls.listDevices.mockReset().mockResolvedValue([]);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("retries an installation failure and starts detection only after launch", async () => {
    calls.install.mockRejectedValueOnce(new Error("download failed"));
    const detected = vi.fn();
    const { result } = renderHook(() => useAsioSetup(detected));
    await act(async () => result.current.install());
    expect(result.current).toMatchObject({
      phase: "failed",
      error: "download failed",
    });
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(calls.listDevices).not.toHaveBeenCalled();
    await act(async () => result.current.install());
    expect(result.current.phase).toBe("launched");
    expect(result.current.error).toBeUndefined();
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(calls.listDevices).toHaveBeenCalledOnce();
    expect(calls.install).toHaveBeenCalledTimes(2);
  });

  it("preserves detection after a failed check and clears its error on a successful retry", async () => {
    calls.listDevices.mockRejectedValueOnce(new Error("enumeration failed"));
    const detected = vi.fn();
    const { result } = renderHook(() => useAsioSetup(detected));
    await act(async () => result.current.install());
    await act(async () => {
      await result.current.detect();
    });
    expect(result.current).toMatchObject({
      phase: "launched",
      error: "enumeration failed",
    });
    calls.listDevices.mockResolvedValue([driver]);
    await act(async () => {
      await result.current.detect();
    });
    expect(detected).toHaveBeenCalledExactlyOnceWith(driver);
    expect(result.current.phase).toBe("detected");
    expect(result.current.error).toBeUndefined();
  });

  it("continues 1500ms detection while the callback changes every second", async () => {
    calls.listDevices.mockResolvedValueOnce([]).mockResolvedValueOnce([driver]);
    const callbacks = [vi.fn(), vi.fn(), vi.fn()] as const;
    const { result, rerender } = renderHook(
      ({ onDetected }) => useAsioSetup(onDetected),
      { initialProps: { onDetected: callbacks[0] } },
    );
    await act(async () => result.current.install());
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    rerender({ onDetected: callbacks[1] });
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(calls.listDevices).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(500));
    rerender({ onDetected: callbacks[2] });
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(calls.listDevices).toHaveBeenCalledTimes(2);
    expect(callbacks[0]).not.toHaveBeenCalled();
    expect(callbacks[1]).not.toHaveBeenCalled();
    expect(callbacks[2]).toHaveBeenCalledExactlyOnceWith(driver);
    expect(result.current.phase).toBe("detected");
  });

  it("keeps the completed detection phase when restarting fails", async () => {
    calls.listDevices.mockResolvedValue([driver]);
    calls.relaunch.mockRejectedValueOnce(new Error("restart denied"));
    const detected = vi.fn();
    const { result } = renderHook(() => useAsioSetup(detected));
    await act(async () => {
      await result.current.detect();
    });
    await act(async () => result.current.restart());
    expect(result.current).toMatchObject({
      phase: "detected",
      error: "restart denied",
    });
    await act(async () => result.current.restart());
    expect(calls.relaunch).toHaveBeenCalledTimes(2);
    expect(calls.install).not.toHaveBeenCalled();
  });

  it("does not overlap detection or accept a driver after the owner unmounts", async () => {
    let finish!: (drivers: readonly DeviceDto[]) => void;
    calls.listDevices.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const detected = vi.fn();
    const { result, unmount } = renderHook(() => useAsioSetup(detected));
    let operation!: Promise<boolean>;
    act(() => {
      operation = result.current.detect();
      void result.current.detect();
    });
    expect(calls.listDevices).toHaveBeenCalledOnce();
    unmount();
    await act(async () => {
      finish([driver]);
      await operation;
    });
    expect(detected).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
