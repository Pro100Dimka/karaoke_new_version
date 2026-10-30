import { tr } from "@neo-ui-kit/react";
import LocalizationProvider from "../../../../providers/localization";
import { store } from "../../../../providers/store";
import { ru } from "../../../../i18n/messages.ru";
import { en } from "../../../../i18n/messages.en";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRecordingPlayback } from "./useRecordingPlayback";
import { RecordingPlayer } from "./RecordingPlayer";

const audio = vi.hoisted(() => ({
  playRecording: vi.fn(),
  pauseRecordingPreview: vi.fn(),
  stopRecordingPreview: vi.fn(),
  seekRecordingPreview: vi.fn(),
  recordingPreviewStatus: vi.fn(),
  setPreviewVolume: vi.fn(),
}));
vi.mock("../../../../services/audioClient", () => ({ audioClient: audio }));
vi.mock("../../../../providers/notifications", () => ({ useNotify: () => vi.fn() }));

vi.mock("../../../../shared/hooks/useWaveformPeaks", () => ({ useRecordingPeaks: () => [0.2, 0.5, 0.3] }));
const recording = {
  id: "take",
  filePath: "take.wav",
  songId: "song",
  displayName: "Take",
  createdAt: "2026-09-25T00:00:00Z",
  durationSeconds: 60,
  sizeBytes: 0,
  analyzed: false,
};

describe("recording preview polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const method of Object.values(audio))
      method.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("exposes a permanent rotary volume control that changes the actual preview gain", () => {
    render(<><RecordingPlayer recording={recording} /></>);
    const knob = screen.getByRole("slider", { name: ru.recordingVolume });
    expect(knob.closest(".ad-rotary-knob")).not.toBeNull();
    expect(knob).toHaveAttribute("aria-valuenow", "1");
    fireEvent.keyDown(knob, { key: "ArrowDown" });
    expect(audio.setPreviewVolume).toHaveBeenLastCalledWith(0.99);
    expect(knob).toHaveAttribute("aria-valuenow", "0.99");
    fireEvent.keyDown(knob, { key: "Home" });
    expect(audio.setPreviewVolume).toHaveBeenLastCalledWith(0);
  });

  it("updates the memoized volume label when the interface language changes without resetting gain", () => {
    const language = store.preferences.language;
    try {
      act(() => store.setLanguage("ru"));
      render(<LocalizationProvider><RecordingPlayer recording={recording} /></LocalizationProvider>);
      const knob = screen.getByRole("slider", { name: ru.recordingVolume });
      fireEvent.keyDown(knob, { key: "ArrowDown" });
      act(() => store.setLanguage("en"));
      expect(tr(ru.errorRecordingTimingUnavailable)).toBe(en.errorRecordingTimingUnavailable);
      expect(screen.getByRole("slider", { name: en.recordingVolume })).toHaveAttribute("aria-valuenow", "0.99");
      act(() => store.setLanguage("ru"));
      expect(screen.getByRole("slider", { name: ru.recordingVolume })).toHaveAttribute("aria-valuenow", "0.99");
    } finally {
      act(() => store.setLanguage(language));
    }
  });

  it("keeps one slow status request in flight", async () => {
    audio.recordingPreviewStatus.mockReturnValue(new Promise(() => undefined));
    const { result } = renderHook(() => useRecordingPlayback(recording));
    await act(() => result.current.toggle());
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(audio.recordingPreviewStatus).toHaveBeenCalledOnce();
  });

  it("ignores a pending status reply after playback is paused", async () => {
    let resolve!: (value: unknown) => void;
    audio.recordingPreviewStatus.mockReturnValue(
      new Promise((value) => {
        resolve = value;
      }),
    );
    const { result } = renderHook(() => useRecordingPlayback(recording));
    await act(() => result.current.toggle());
    await act(() => vi.advanceTimersByTimeAsync(100));
    await act(() => result.current.toggle());
    await act(async () => {
      resolve({ recordingId: "take", state: "playing", positionSeconds: 17 });
    });
    expect(result.current.position).toBe(0);
    expect(result.current.playing).toBe(false);
  });

  it("releases a preview that is still loading when its player unmounts", async () => {
    let finish!: () => void;
    audio.playRecording.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const { result, unmount } = renderHook(() => useRecordingPlayback(recording));
    let playing!: Promise<void>;
    act(() => { playing = result.current.toggle(); });
    unmount();
    expect(audio.stopRecordingPreview).toHaveBeenCalledOnce();
    await act(async () => { finish(); await playing; });
    expect(audio.recordingPreviewStatus).not.toHaveBeenCalled();
  });
});
