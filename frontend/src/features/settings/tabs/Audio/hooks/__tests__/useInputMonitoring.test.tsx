import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppProvider, useApp } from "../../../../../../app/AppContext";
import { NotificationsProvider } from "../../../../../../app/NotificationsProvider";
import { audioClient } from "../../../../../../services/audioClient";
import { SettingsProvider } from "../../../../SettingsProvider";
import { applyVoiceChain } from "../../../../../karaoke/console/voiceChain";
import { audioSessionFor } from "../../model/audioSession";
import { useInputMonitoring } from "../useInputMonitoring";

vi.mock("../../../../../karaoke/console/voiceChain", () => ({
  applyVoiceChain: vi.fn(async () => undefined),
}));

vi.mock("../../../../../../services/audioClient", () => ({
  audioClient: {
    setMonitoring: vi.fn(async () => ({})),
    setDspEnabled: vi.fn(async () => undefined),
    testInputLevel: vi.fn(async () => 0.1),
    snapshot: vi.fn(async () => ({
      monitoring: true,
      monitoringSafetyTripped: false,
    })),
    runtimeConfiguration: vi.fn(async () => ({})),
  },
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <AppProvider>
    <SettingsProvider>
      <NotificationsProvider>{children}</NotificationsProvider>
    </SettingsProvider>
  </AppProvider>
);

const monitoringCalls = () =>
  vi.mocked(audioClient.setMonitoring).mock.calls.map((call) => call[0]);

describe("useInputMonitoring", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("monitors the microphone while the input test is on and stops when it is turned off", async () => {
    const { result } = renderHook(() => useInputMonitoring(true), {
      wrapper,
    });
    act(() => result.current.setTestingInput(true));
    await waitFor(() => expect(monitoringCalls()).toEqual([true]));
    expect(audioClient.setDspEnabled).toHaveBeenCalledWith(false);
    act(() => result.current.setTestingInput(false));
    await waitFor(() => expect(monitoringCalls()).toEqual([true, false]));
  });

  it("switches the test and monitoring off when the settings are left", async () => {
    const { result, unmount } = renderHook(() => useInputMonitoring(true), {
      wrapper,
    });
    act(() => result.current.setTestingInput(true));
    await waitFor(() => expect(monitoringCalls()).toEqual([true]));
    unmount();
    await waitFor(() => expect(monitoringCalls()).toEqual([true, false]));
    const reopened = renderHook(() => useInputMonitoring(true), { wrapper });
    expect(reopened.result.current.testingInput).toBe(false);
  });

  it("does not start monitoring after leaving Audio while DSP setup is pending", async () => {
    let finishDsp!: () => void;
    vi.mocked(audioClient.setDspEnabled).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDsp = resolve;
        }),
    );
    const { result, unmount } = renderHook(() => useInputMonitoring(true), {
      wrapper,
    });

    act(() => result.current.setTestingInput(true));
    await waitFor(() =>
      expect(audioClient.setDspEnabled).toHaveBeenCalledWith(false),
    );
    unmount();
    await act(async () => finishDsp());

    expect(monitoringCalls()).toEqual([false]);
  });

  it("stops monitoring after leaving Audio while its start request is pending", async () => {
    let finishStart!: () => void;
    vi.mocked(audioClient.setMonitoring).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishStart = () =>
            resolve({
              sessionId: "",
              state: "ready",
              positionSeconds: 0,
              durationSeconds: 0,
              recording: false,
              monitoring: true,
              inputLevel: 0,
            });
        }),
    );
    const { result, unmount } = renderHook(() => useInputMonitoring(true), {
      wrapper,
    });

    act(() => result.current.setTestingInput(true));
    await waitFor(() => expect(monitoringCalls()).toEqual([true]));
    unmount();
    await act(async () => finishStart());

    expect(monitoringCalls()).toEqual([true, false]);
  });

  it("does not touch monitoring while no test runs", () => {
    renderHook(() => useInputMonitoring(true), { wrapper });
    expect(monitoringCalls()).toEqual([]);
  });

  it("allows an active test to stop after starting becomes forbidden, then blocks restart", async () => {
    const { result, rerender } = renderHook(
      ({ canStart }) => useInputMonitoring(canStart),
      { wrapper, initialProps: { canStart: true } },
    );
    act(() => result.current.setTestingInput(true));
    await waitFor(() => expect(monitoringCalls()).toEqual([true]));
    rerender({ canStart: false });
    expect(result.current.testingInput).toBe(true);
    expect(result.current.canToggle).toBe(true);
    act(() => result.current.setTestingInput(false));
    await waitFor(() => expect(monitoringCalls()).toEqual([true, false]));
    expect(result.current.canToggle).toBe(false);
    act(() => result.current.setTestingInput(true));
    expect(result.current.testingInput).toBe(false);
    expect(monitoringCalls()).toEqual([true, false]);
  });

  it("rejects starting without permission and accepts it after permission returns", async () => {
    const { result, rerender } = renderHook(
      ({ canStart }) => useInputMonitoring(canStart),
      { wrapper, initialProps: { canStart: false } },
    );
    act(() => result.current.setTestingInput(true));
    expect(result.current.testingInput).toBe(false);
    expect(result.current.canToggle).toBe(false);
    expect(monitoringCalls()).toEqual([]);
    rerender({ canStart: true });
    expect(result.current.canToggle).toBe(true);
    act(() => result.current.setTestingInput(true));
    await waitFor(() => expect(monitoringCalls()).toEqual([true]));
  });

  it("restores the latest voice settings without restarting monitoring when preferences change", async () => {
    const { result } = renderHook(
      () => {
        const monitoring = useInputMonitoring(true);
        const { updatePreferences } = useApp("preferences");
        return { ...monitoring, updatePreferences };
      },
      { wrapper },
    );
    act(() => result.current.setTestingInput(true));
    await waitFor(() => expect(monitoringCalls()).toEqual([true]));
    act(() => result.current.updatePreferences({ voiceGain: 0.42 }));
    expect(monitoringCalls()).toEqual([true]);
    act(() => result.current.setTestingInput(false));
    await waitFor(() =>
      expect(applyVoiceChain).toHaveBeenCalledWith(
        expect.objectContaining({ voiceGain: 0.42 }),
        audioClient,
      ),
    );
    expect(monitoringCalls()).toEqual([true, false]);
  });

  it("finishes a pending old start and cleanup before a rapid re-enable", async () => {
    let finishStart!: () => void;
    vi.mocked(audioClient.setMonitoring).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishStart = () => resolve({} as never);
        }),
    );
    const { result } = renderHook(() => useInputMonitoring(true), {
      wrapper,
    });
    act(() => result.current.setTestingInput(true));
    await waitFor(() => expect(monitoringCalls()).toEqual([true]));
    act(() => result.current.setTestingInput(false));
    act(() => result.current.setTestingInput(true));
    await act(async () => finishStart());
    await waitFor(() => expect(monitoringCalls()).toEqual([true, false, true]));
    expect(result.current.testingInput).toBe(true);
  });

  it("ignores a meter response that finishes after the test is stopped", async () => {
    const refresh = vi.spyOn(audioSessionFor(audioClient), "refresh");
    let finishRead!: (level: number) => void;
    vi.mocked(audioClient.testInputLevel).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    const { result } = renderHook(() => useInputMonitoring(true), {
      wrapper,
    });
    act(() => result.current.setTestingInput(true));
    await waitFor(() => expect(audioClient.testInputLevel).toHaveBeenCalled());
    act(() => result.current.setTestingInput(false));
    await act(async () => finishRead(0.9));
    expect(result.current.inputLevel).toBe(0);
    expect(result.current.testingInput).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("ends the input test when AudioService trips monitoring protection", async () => {
    vi.mocked(audioClient.snapshot).mockResolvedValue({
      monitoring: false,
      monitoringSafetyTripped: true,
    } as never);
    const { result } = renderHook(() => useInputMonitoring(true), {
      wrapper,
    });
    act(() => result.current.setTestingInput(true));
    await waitFor(() => expect(result.current.testingInput).toBe(false));
  });

  it("keeps sampling and checking safety while diagnostics are pending, then stops cleanly", async () => {
    vi.useFakeTimers();
    let finishRefresh!: () => void;
    const refresh = vi
      .spyOn(audioSessionFor(audioClient), "refresh")
      .mockReturnValue(
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
      );
    vi.mocked(audioClient.snapshot).mockResolvedValue({
      monitoring: true,
      monitoringSafetyTripped: false,
    } as never);
    const { result, unmount } = renderHook(() => useInputMonitoring(true), {
      wrapper,
    });

    await act(async () => result.current.setTestingInput(true));
    expect(audioClient.setMonitoring).toHaveBeenCalledWith(true);
    for (let sample = 0; sample < 5; sample += 1)
      await act(async () => vi.advanceTimersByTimeAsync(110));

    expect(audioClient.testInputLevel).toHaveBeenCalledTimes(6);
    expect(audioClient.snapshot).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);

    await act(async () => result.current.setTestingInput(false));
    expect(monitoringCalls()).toEqual([true, false]);
    expect(result.current.inputLevel).toBe(0);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(audioClient.testInputLevel).toHaveBeenCalledTimes(6);
    await act(async () => finishRefresh());
    expect(audioClient.testInputLevel).toHaveBeenCalledTimes(6);
    unmount();
  });
});
