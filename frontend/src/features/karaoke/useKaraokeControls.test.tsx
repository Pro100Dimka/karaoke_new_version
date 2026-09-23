import { act, renderHook, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppProvider, useApp } from "../../app/AppContext";
import { audioClient } from "../../services/audioClient";
import { roomClient } from "../../services/roomClient";
import { recordingCoordinator } from "../../services/recordingCoordinator";
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

vi.mock("../../services/roomClient", () => ({
  roomClient: { roomControl: vi.fn(async () => ({ code: "ROOM", role: "host", participants: [], playbackLocked: false })) }
}));

vi.mock("../../services/recordingCoordinator", () => ({
  recordingCoordinator: { updatePlaybackAdjustment: vi.fn() }
}));

const wrapper = ({ children }: { children: ReactNode }) => <AppProvider>{children}</AppProvider>;
const RoomSeed = ({ children }: { children: ReactNode }) => {
  const { room, setRoom } = useApp();
  useEffect(() => {
    if (!room) setRoom({ code: "ROOM", hostId: "self", role: "host", participants: [], playbackLocked: false });
  }, [room, setRoom]);
  return children;
};
const roomWrapper = ({ children }: { children: ReactNode }) => <AppProvider><RoomSeed>{children}</RoomSeed></AppProvider>;

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
        position,
        speed: { current: 1 },
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

  it("keeps tempo and key session-only and allows changing them during recording", async () => {
    const key = { current: 0 };
    const speed = { current: 1 };
    const { result } = renderHook(
      () => useKaraokeControls({
        position: { current: 0 },
        key,
        speed,
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
      karaokeSpeed: 1,
      karaokeKeyShift: 0,
      referenceGain: 0.37
    }));
    expect(recordingCoordinator.updatePlaybackAdjustment).toHaveBeenLastCalledWith({
      sourceSeconds: 0,
      playbackRate: 0.85,
      keyShift: -2
    });
  });

  it("routes host seeking through the authoritative room instead of local audio", async () => {
    const { result } = renderHook(
      () => useKaraokeControls({
        position: { current: 0 },
        speed: { current: 1 },
        key: { current: 0 },
        monitoring: false,
        microphoneReady: true,
        setPosition: vi.fn(),
        setSpeed: vi.fn(),
        setKeyShift: vi.fn(),
        setGains: vi.fn(),
        setMonitoring: vi.fn()
      }),
      { wrapper: roomWrapper }
    );
    await waitFor(() => expect(result.current).toBeDefined());

    await act(() => result.current.seek(42));

    expect(roomClient.roomControl).toHaveBeenCalledWith("ROOM", "Seek", 42);
    expect(audioClient.seek).not.toHaveBeenCalled();
  });
});
