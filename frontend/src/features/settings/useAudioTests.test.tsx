import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../app/AppContext";
import { NotificationsProvider } from "../../app/NotificationsProvider";
import { audioClient } from "../../services/audioClient";
import { useAudioTests } from "./useAudioTests";

vi.mock("../../services/audioClient", () => ({
  audioClient: {
    setMonitoring: vi.fn(async () => ({})),
    testInputLevel: vi.fn(async () => 0.1),
    runtimeConfiguration: vi.fn(async () => ({})),
    playTestSound: vi.fn(async () => undefined)
  }
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <AppProvider>
    <NotificationsProvider>{children}</NotificationsProvider>
  </AppProvider>
);

const monitoringCalls = () => vi.mocked(audioClient.setMonitoring).mock.calls.map(call => call[0]);

describe("useAudioTests", () => {
  beforeEach(() => vi.clearAllMocks());

  it("monitors the microphone while the input test is on and stops when it is turned off", async () => {
    const { result } = renderHook(() => useAudioTests(true, vi.fn()), { wrapper });
    act(() => result.current.setTestingInput(true));
    await vi.waitFor(() => expect(monitoringCalls()).toEqual([true]));
    act(() => result.current.setTestingInput(false));
    await vi.waitFor(() => expect(monitoringCalls()).toEqual([true, false]));
  });

  it("switches the test and monitoring off when the settings are left", async () => {
    const { result, rerender } = renderHook(({ open }) => useAudioTests(open, vi.fn()), { wrapper, initialProps: { open: true } });
    act(() => result.current.setTestingInput(true));
    await vi.waitFor(() => expect(monitoringCalls()).toEqual([true]));
    rerender({ open: false });
    await vi.waitFor(() => expect(monitoringCalls()).toEqual([true, false]));
    expect(result.current.testingInput).toBe(false);
  });

  it("does not touch monitoring while no test runs", () => {
    renderHook(() => useAudioTests(true, vi.fn()), { wrapper });
    expect(monitoringCalls()).toEqual([]);
  });
});
