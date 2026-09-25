import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SongDto } from "../../contracts/models";
import { audioClient } from "../../services/audioClient";
import { useAudioRecovery } from "./useAudioRecovery";

vi.mock("../../services/audioClient", () => ({ audioClient: {
  health: vi.fn(), prepareSong: vi.fn(), setPlaybackRate: vi.fn(), setPitchShift: vi.fn(), seek: vi.fn(),
} }));

beforeEach(() => { vi.resetAllMocks(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

it("keeps one recovery in flight and abandons it before touching a departed session", async () => {
  let health!: (value: { status: "ready"; version: string }) => void;
  vi.mocked(audioClient.health).mockReturnValue(new Promise(resolve => { health = resolve; }));
  const onRecovered = vi.fn();
  const { unmount } = renderHook(() => useAudioRecovery({
    recovering: true, song: { current: { id: "song" } as SongDto }, position: { current: 10 },
    speed: { current: 1 }, key: { current: 0 }, onRecovered,
  }));
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  const count = vi.mocked(audioClient.health).mock.calls.length;
  unmount();
  await act(async () => { health({ status: "ready", version: "1" }); });
  expect(audioClient.prepareSong).not.toHaveBeenCalled();
  expect(onRecovered).not.toHaveBeenCalled();
  expect(count).toBe(1);
});

it("handles failed health probes and stops commands after an interrupted preparation", async () => {
  vi.mocked(audioClient.health).mockRejectedValueOnce(new Error("lost pipe"))
    .mockResolvedValue({ status: "ready", version: "1" });
  let prepared!: () => void;
  vi.mocked(audioClient.prepareSong).mockReturnValue(new Promise(resolve => { prepared = () => resolve({} as never); }));
  const onRecovered = vi.fn();
  const { unmount } = renderHook(() => useAudioRecovery({
    recovering: true, song: { current: { id: "song" } as SongDto }, position: { current: 10 },
    speed: { current: 1 }, key: { current: 0 }, onRecovered,
  }));
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(audioClient.prepareSong).toHaveBeenCalledOnce();
  unmount();
  await act(async () => { prepared(); });
  expect(audioClient.setPlaybackRate).not.toHaveBeenCalled();
  expect(onRecovered).not.toHaveBeenCalled();
});
