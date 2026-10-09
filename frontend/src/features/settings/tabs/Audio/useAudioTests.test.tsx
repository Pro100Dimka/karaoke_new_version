import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../../../app/AppContext";
import { NotificationsProvider } from "../../../../app/NotificationsProvider";
import { SettingsProvider } from "../../../../app/SettingsProvider";
import { audioClient } from "../../../../services/audioClient";
import { useAudioTests } from "./useAudioTests";

vi.mock("../../../../services/audioClient", () => ({
  audioClient: {
    setMonitoring: vi.fn(async () => ({})),
    setDspEnabled: vi.fn(async () => undefined),
    testInputLevel: vi.fn(async () => 0.1),
    snapshot: vi.fn(async () => ({ monitoring: true, monitoringSafetyTripped: false })),
    runtimeConfiguration: vi.fn(async () => ({})),
    playTestSound: vi.fn(async () => undefined),
  },
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <AppProvider>
    <SettingsProvider><NotificationsProvider>{children}</NotificationsProvider></SettingsProvider>
  </AppProvider>
);

const monitoringCalls = () =>
  vi.mocked(audioClient.setMonitoring).mock.calls.map((call) => call[0]);

describe("useAudioTests", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it("monitors the microphone while the input test is on and stops when it is turned off", async () => {
    const { result } = renderHook(() => useAudioTests(true, vi.fn()), {
      wrapper,
    });
    act(() => result.current.setTestingInput(true));
    await vi.waitFor(() => expect(monitoringCalls()).toEqual([true]));
    expect(audioClient.setDspEnabled).toHaveBeenCalledWith(false);
    act(() => result.current.setTestingInput(false));
    await vi.waitFor(() => expect(monitoringCalls()).toEqual([true, false]));
  });

  it("switches the test and monitoring off when the settings are left", async () => {
    const { result, rerender } = renderHook(
      ({ open }) => useAudioTests(open, vi.fn()),
      { wrapper, initialProps: { open: true } },
    );
    act(() => result.current.setTestingInput(true));
    await vi.waitFor(() => expect(monitoringCalls()).toEqual([true]));
    rerender({ open: false });
    await vi.waitFor(() => expect(monitoringCalls()).toEqual([true, false]));
    expect(result.current.testingInput).toBe(false);
  });

  it("does not start monitoring after leaving Audio while DSP setup is pending", async () => {
    let finishDsp!: () => void;
    vi.mocked(audioClient.setDspEnabled).mockImplementationOnce(() =>
      new Promise<void>((resolve) => { finishDsp = resolve; }),
    );
    const { result, unmount } = renderHook(() => useAudioTests(true, vi.fn()), { wrapper });

    act(() => result.current.setTestingInput(true));
    await vi.waitFor(() => expect(audioClient.setDspEnabled).toHaveBeenCalledWith(false));
    unmount();
    await act(async () => finishDsp());

    expect(monitoringCalls()).toEqual([false]);
  });

  it("stops monitoring after leaving Audio while its start request is pending", async () => {
    let finishStart!: () => void;
    vi.mocked(audioClient.setMonitoring).mockImplementationOnce(() =>
      new Promise((resolve) => {
        finishStart = () => resolve({
          sessionId: "", state: "ready", positionSeconds: 0, durationSeconds: 0,
          recording: false, monitoring: true, inputLevel: 0,
        });
      }),
    );
    const { result, unmount } = renderHook(() => useAudioTests(true, vi.fn()), { wrapper });

    act(() => result.current.setTestingInput(true));
    await vi.waitFor(() => expect(monitoringCalls()).toEqual([true]));
    unmount();
    await act(async () => finishStart());

    expect(monitoringCalls()).toEqual([true, false, false]);
  });

  it("does not touch monitoring while no test runs", () => {
    renderHook(() => useAudioTests(true, vi.fn()), { wrapper });
    expect(monitoringCalls()).toEqual([]);
  });

  it("ends the input test when AudioService trips monitoring protection", async () => {
    vi.mocked(audioClient.snapshot).mockResolvedValue({
      monitoring: false,
      monitoringSafetyTripped: true,
    } as never);
    const { result } = renderHook(() => useAudioTests(true, vi.fn()), { wrapper });
    act(() => result.current.setTestingInput(true));
    await vi.waitFor(() => expect(result.current.testingInput).toBe(false));
  });

  it("keeps the live meter responsive without requesting full diagnostics for every sample", async () => {
    vi.useFakeTimers();
    vi.mocked(audioClient.snapshot).mockResolvedValue({
      monitoring: true,
      monitoringSafetyTripped: false,
    } as never);
    const { result, unmount } = renderHook(() => useAudioTests(true, vi.fn()), { wrapper });

    await act(async () => result.current.setTestingInput(true));
    expect(audioClient.setMonitoring).toHaveBeenCalledWith(true);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    for (let sample = 0; sample < 4; sample += 1)
      await act(async () => vi.advanceTimersByTimeAsync(110));

    expect(audioClient.testInputLevel).toHaveBeenCalledTimes(5);
    expect(audioClient.snapshot).toHaveBeenCalledTimes(1);
    unmount();
  });
});
