import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomStateDto } from "../../contracts/models";
import { useSynchronizedRoomPlayback } from "./useSynchronizedRoomPlayback";

const audio = vi.hoisted(() => ({ seek: vi.fn(), play: vi.fn(), pause: vi.fn() }));
const getAudioSnapshot = vi.hoisted(() => vi.fn());
vi.mock("../../services/audioClient", () => ({ audioClient: audio, getAudioSnapshot }));

const snapshot = (): RoomStateDto => ({
  code: "room", hostId: "host", role: "participant", participants: [], playbackLocked: true,
  songId: "song", revision: 1, playbackState: "playing", playbackPositionSeconds: 12,
  serverNow: "2026-09-24T10:00:00Z", playbackStartedAt: "2026-09-24T10:00:00.500Z",
});

const options = () => ({
  room: snapshot(), ready: true, stateKind: "ready" as const,
  onEvent: vi.fn(), onFinished: vi.fn(), onFailure: vi.fn(),
});
const advance = async (ms: number) => { await act(() => vi.advanceTimersByTimeAsync(ms)); };

describe("room playback scheduling lifecycle", () => {
  it("arms the native deadline before the renderer countdown expires", async () => {
    const initial = options();
    renderHook(useSynchronizedRoomPlayback, { initialProps: initial });
    await advance(0);
    expect(audio.play).toHaveBeenCalledWith({ startAtMilliseconds: 500, positionSeconds: 12 });
    expect(audio.seek).not.toHaveBeenCalled();
    expect(initial.onEvent).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    vi.setSystemTime(new Date("2026-09-24T10:00:00Z"));
    for (const method of Object.values(audio)) method.mockReset().mockResolvedValue(undefined);
    let state = "ready", positionSeconds = 0, startAt = 0;
    const position = () => positionSeconds + (state === "playing" ? Math.max(0, performance.now() - startAt) / 1000 : 0);
    getAudioSnapshot.mockReset().mockImplementation(async () => ({ state, positionSeconds: position() }));
    audio.seek.mockImplementation(async value => { positionSeconds = value; });
    audio.play.mockImplementation(async schedule => {
      positionSeconds = schedule?.positionSeconds ?? position();
      startAt = schedule?.startAtMilliseconds ?? performance.now();
      state = "playing";
    });
    audio.pause.mockImplementation(async () => { positionSeconds = position(); state = "paused"; });
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
    expect(audio.pause).toHaveBeenCalledOnce();
    rerender(initial);
    await advance(600);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it("reports errors raised by the scheduled start", async () => {
    const failure = new Error("device lost");
    audio.play.mockRejectedValueOnce(failure);
    const initial = options();
    renderHook(useSynchronizedRoomPlayback, { initialProps: initial });
    await advance(500);
    expect(initial.onFailure).toHaveBeenCalledWith(failure);
  });

  it("cancels an armed start without emitting stale UI events when readiness is lost", async () => {
    let resolvePlay!: () => void;
    audio.play.mockImplementationOnce(() => new Promise<void>(resolve => { resolvePlay = () => {
      getAudioSnapshot.mockResolvedValue({ state: "playing", positionSeconds: 12 }); resolve();
    }; }));
    const initial = options();
    initial.room.playbackStartedAt = initial.room.serverNow;
    const { rerender } = renderHook(useSynchronizedRoomPlayback, { initialProps: initial });
    await advance(0);
    expect(audio.play).toHaveBeenCalledOnce();
    rerender({ ...initial, ready: false });
    resolvePlay();
    await advance(0);
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(initial.onEvent).not.toHaveBeenCalled();
  });

  it("uses the common scheduled start for participants with different voice latency", async () => {
    const initial = options();
    const participant = { name: "voice", role: "participant" as const, connected: true,
      muted: false, speakingLevel: 0, volume: 1, readiness: "ready" as const };
    initial.room.participants = [
      { ...participant, id: "self", self: true, voiceLatencyMs: 10 },
      { ...participant, id: "other", self: false, voiceLatencyMs: 110 },
    ];
    renderHook(useSynchronizedRoomPlayback, { initialProps: initial });
    await advance(500);
    expect(audio.play).toHaveBeenCalledWith({ startAtMilliseconds: 500, positionSeconds: 12 });
    expect(audio.play).toHaveBeenCalledOnce();
  });

  it("checks the current native position instead of seeking from a stale UI poll", async () => {
    const initial = { ...options(), stateKind: "playing" as const };
    initial.room.playbackStartedAt = "2026-09-24T09:59:50Z";
    getAudioSnapshot.mockResolvedValue({ positionSeconds: 22 });
    renderHook(useSynchronizedRoomPlayback, { initialProps: initial });
    await advance(0);
    expect(getAudioSnapshot).toHaveBeenCalledOnce();
    expect(audio.seek).not.toHaveBeenCalled();
  });

  it("preserves the scheduled monotonic deadline when the system clock changes", async () => {
    const initial = options();
    initial.room.serverClockOffsetMilliseconds = Date.parse(initial.room.serverNow ?? "");
    renderHook(useSynchronizedRoomPlayback, { initialProps: initial });
    await advance(100);
    vi.setSystemTime(new Date("2026-09-24T09:00:00Z"));
    await advance(400);
    expect(audio.play).toHaveBeenCalledOnce();
    expect(audio.play).toHaveBeenCalledWith({ startAtMilliseconds: 500, positionSeconds: 12 });
  });

  it.each(["pause", "play"] as const)("serializes overlapping %s snapshots and reconciles from native state", async command => {
    let nativeState = command === "pause" ? "playing" : "paused";
    const initial = { ...options(), stateKind: command === "pause" ? "playing" as const : "paused" as const };
    initial.room.playbackState = command === "pause" ? "paused" : "playing";
    initial.room.playbackStartedAt = initial.room.serverNow;
    getAudioSnapshot.mockImplementation(async () => ({ state: nativeState, positionSeconds: 12 }));
    let finishCommand!: () => void;
    audio[command].mockImplementationOnce(() => new Promise<void>(resolve => {
      finishCommand = () => { nativeState = command === "pause" ? "paused" : "playing"; resolve(); };
    }));
    const { rerender } = renderHook(useSynchronizedRoomPlayback, { initialProps: initial });
    await advance(0);
    expect(audio[command]).toHaveBeenCalledOnce();
    rerender({ ...initial, room: { ...initial.room, serverNow: "2026-09-24T10:00:00.001Z" } });
    await advance(0);
    const callsWhilePending = audio[command].mock.calls.length;
    finishCommand();
    await advance(0);
    expect(callsWhilePending).toBe(1);
    expect(audio[command]).toHaveBeenCalledOnce();
    expect(initial.onEvent).toHaveBeenCalledWith(command === "pause" ? "PAUSE" : "PLAY");
    expect(initial.onFailure).not.toHaveBeenCalled();
  });

  it("does not restart a finished native stream while the UI is still playing", async () => {
    const initial = { ...options(), stateKind: "playing" as const };
    initial.room.playbackStartedAt = initial.room.serverNow;
    getAudioSnapshot.mockResolvedValue({ state: "finished", positionSeconds: 12 });
    renderHook(useSynchronizedRoomPlayback, { initialProps: initial });
    await advance(0);
    expect(audio.play).not.toHaveBeenCalled();
    expect(initial.onFinished).toHaveBeenCalledOnce();
  });
});
