import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../app/AppContext";
import { audioClient } from "../../services/audioClient";
import { useKaraokeControls } from "./useKaraokeControls";

vi.mock("../../services/audioClient", () => ({
  audioClient: {
    seek: vi.fn(async (seconds: number) => ({ positionSeconds: seconds }))
  }
}));

const wrapper = ({ children }: { children: ReactNode }) => <AppProvider>{children}</AppProvider>;

describe("useKaraokeControls", () => {
  beforeEach(() => vi.clearAllMocks());

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
});
