import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../app/AppContext";
import { audioClient } from "../../services/audioClient";
import { loadPreferences } from "../../shared/preferences/preferences";
import { useKaraokeControls } from "./useKaraokeControls";

vi.mock("../../services/audioClient", () => ({
  audioClient: {
    seek: vi.fn(async (seconds: number) => ({ positionSeconds: seconds })),
    setPlaybackRate: vi.fn(async () => undefined),
    setPitchShift: vi.fn(async () => undefined),
    setMixer: vi.fn(async () => undefined)
  }
}));

const wrapper = ({ children }: { children: ReactNode }) => <AppProvider>{children}</AppProvider>;

describe("useKaraokeControls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("allows seeking while a karaoke take is being recorded", async () => {
    const position = { current: 12 };
    const setPosition = vi.fn();
    const { result } = renderHook(
      () => useKaraokeControls({
        recording: { current: "recording" },
        position,
        key: { current: 0 },
        monitoring: false,
        microphoneReady: true,
        setPosition,
        setSpeed: vi.fn(),
        setKeyShift: vi.fn(),
        setGains: vi.fn(),
        setMonitoring: vi.fn()
      }),
      { wrapper }
    );

    await act(() => result.current.seek(42));

    expect(audioClient.seek).toHaveBeenCalledWith(42);
    expect(position.current).toBe(42);
    expect(setPosition).toHaveBeenCalledWith(42);
  });

  it("persists transport and every mixer knob for the next song", async () => {
    const key = { current: 0 };
    const { result } = renderHook(
      () => useKaraokeControls({
        recording: { current: "idle" },
        position: { current: 0 },
        key,
        monitoring: false,
        microphoneReady: true,
        setPosition: vi.fn(),
        setSpeed: vi.fn(),
        setKeyShift: vi.fn(),
        setGains: vi.fn(),
        setMonitoring: vi.fn()
      }),
      { wrapper }
    );

    await act(() => result.current.changeSpeed(0.85));
    await act(() => result.current.changeKey(-2));
    await act(() => result.current.changeGain("reference", 0.37));

    await waitFor(() => expect(loadPreferences()).toMatchObject({
      karaokeSpeed: 0.85,
      karaokeKeyShift: -2,
      referenceGain: 0.37
    }));
  });
});
