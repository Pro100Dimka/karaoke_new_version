import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomStateDto } from "../../contracts/models";
import { useSynchronizedRoomPlayback } from "./useSynchronizedRoomPlayback";

const audio = vi.hoisted(() => ({ seek: vi.fn(), play: vi.fn(), pause: vi.fn() }));
vi.mock("../../services/audioClient", () => ({ audioClient: audio }));

const snapshot = (): RoomStateDto => ({
  code: "room", hostId: "host", role: "participant", participants: [], playbackLocked: true,
  songId: "song", revision: 1, playbackState: "playing", playbackPositionSeconds: 12,
  serverNow: "2026-09-24T10:00:00Z", playbackStartedAt: "2026-09-24T10:00:00.500Z",
});

const options = () => ({
  room: snapshot(), ready: true, stateKind: "ready" as const, position: { current: 0 },
  onEvent: vi.fn(), onFinished: vi.fn(), onFailure: vi.fn(),
});
const advance = async (ms: number) => { await act(() => vi.advanceTimersByTimeAsync(ms)); };

describe("room playback scheduling lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    vi.setSystemTime(new Date("2026-09-24T10:00:00Z"));
    for (const method of Object.values(audio)) method.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  it("preserves a scheduled start across callback changes and uses the latest callback", async () => {
    const initial = options();
    const { rerender } = renderHook(useSynchronizedRoomPlayback, { initialProps: initial });
    await advance(100);
    const onEvent = vi.fn();
    rerender({ ...initial, onEvent });
    await advance(400);
    expect(audio.play).toHaveBeenCalledOnce();
    expect(initial.onEvent).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith("PLAY");
  });

  it("reapplies the same snapshot after readiness is lost and restored", async () => {
    const initial = options();
    const { rerender } = renderHook(useSynchronizedRoomPlayback, { initialProps: initial });
    await advance(100);
    rerender({ ...initial, ready: false });
    await advance(100);
    rerender(initial);
    await advance(600);
    expect(audio.play).toHaveBeenCalledOnce();
  });

  it("reports errors raised by the scheduled start", async () => {
    const failure = new Error("device lost");
    audio.seek.mockRejectedValueOnce(failure);
    const initial = options();
    renderHook(useSynchronizedRoomPlayback, { initialProps: initial });
    await advance(500);
    expect(initial.onFailure).toHaveBeenCalledWith(failure);
  });

  it("does not play or report a stale failure after a pending seek is invalidated", async () => {
    let resolveSeek!: () => void;
    audio.seek.mockImplementationOnce(() => new Promise<void>(resolve => { resolveSeek = resolve; }));
    const initial = options();
    initial.room.playbackStartedAt = initial.room.serverNow;
    const { rerender } = renderHook(useSynchronizedRoomPlayback, { initialProps: initial });
    await advance(0);
    expect(audio.seek).toHaveBeenCalledOnce();
    rerender({ ...initial, ready: false });
    resolveSeek();
    await advance(0);
    expect(audio.play).not.toHaveBeenCalled();
    expect(initial.onEvent).not.toHaveBeenCalled();
  });

  it("accounts for per-participant start delay without dropping a second countdown", async () => {
    const initial = options();
    const participant = { name: "voice", role: "participant" as const, connected: true,
      muted: false, speakingLevel: 0, volume: 1, readiness: "ready" as const };
    initial.room.participants = [
      { ...participant, id: "self", self: true, voiceLatencyMs: 10 },
      { ...participant, id: "other", self: false, voiceLatencyMs: 110 },
    ];
    renderHook(useSynchronizedRoomPlayback, { initialProps: initial });
    await advance(700);
    expect(audio.seek).toHaveBeenCalledWith(12);
    expect(audio.play).toHaveBeenCalledOnce();
  });
});
