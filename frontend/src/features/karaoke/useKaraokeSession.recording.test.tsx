import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKaraokeSession } from "./useKaraokeSession";
import { recordingCoordinator } from "../../services/recordingCoordinator";
import { pythonClient } from "../../services/pythonClient";
import { audioClient } from "../../services/audioClient";
import { usePositionPolling } from "./usePositionPolling";
import { useAudioRecovery } from "./useAudioRecovery";
import type { RoomStateDto } from "../../contracts/models";

const dialogs = vi.hoisted(() => ({ ask: vi.fn() }));
const roomState = vi.hoisted(() => ({ room: null as RoomStateDto | null }));
const monitoringPreference = vi.hoisted(() => ({
  enabled: false,
  microphoneReady: true,
}));
const monitoringWarning = vi.hoisted(() => vi.fn());
vi.mock("../../providers/application", () => ({
  useRoomPlayback: () => null,
  useApp: () => ({
    room: roomState.room,
    preferences: {
      musicGain: 0.42,
      voiceGain: 0.53,
      referenceGain: 0.64,
      melodyGain: 0.75,
      masterGain: 0.86,
      karaokeMonitoring: monitoringPreference.enabled,
      keyboardLighting: false,
      theme: "dark",
    },
    updatePreferences: vi.fn(),
    openSettings: vi.fn(),
  }),
}));
vi.mock("../../providers/dialog", () => ({ ask: dialogs.ask }));
vi.mock("../../providers/close-guards", () => ({ useCloseGuard: vi.fn() }));
vi.mock("../../providers/notifications", () => ({
  useNotify: () => monitoringWarning,
}));

vi.mock("../../services/pythonClient", () => ({
  pythonClient: { freeStorageBytes: vi.fn() },
}));
vi.mock("../../services/audioClient", () => ({
  audioClient: {
    play: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    setMonitoring: vi.fn(async (enabled: boolean) => ({ monitoring: enabled })),
    setDspEnabled: vi.fn(async () => undefined),
    setMixer: vi.fn(async () => undefined),
  },
}));
vi.mock("../../services/recordingCoordinator", () => ({
  recordingCoordinator: {
    elapsedSeconds: () => 0,
    start: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(async () => ({ recording: true })),
    resume: vi.fn(async () => ({ recording: true })),
    observePosition: vi.fn(),
    interrupt: vi.fn(),
    hasPendingTake: () => true,
  },
}));
vi.mock("./usePositionPolling", () => ({
  usePositionPolling: vi.fn(() => ({ invalidate: vi.fn() })),
}));
vi.mock("./useAudioRecovery", () => ({ useAudioRecovery: vi.fn() }));
vi.mock("./useKeyboardLighting", () => ({ useKeyboardLighting: vi.fn() }));
vi.mock("./useSynchronizedRoomPlayback", () => ({
  useSynchronizedRoomPlayback: vi.fn(),
}));
vi.mock("./useKaraokeLoadSession", async () => {
  const { useEffect } = await import("react");
  const song = { id: "song", activeRevision: 1 };
  return {
    useKaraokeLoadSession: (
      _id: string,
      _mode: string,
      _gains: unknown,
      prepared: () => void,
    ) => {
      useEffect(() => {
        prepared();
      }, []);
      return {
        load: { kind: "ready", song },
        capabilities: {
          microphone: monitoringPreference.microphoneReady
            ? "ready"
            : "missing",
        },
      };
    },
  };
});

const startSession = async () => {
  const hook = renderHook(() => useKaraokeSession("song", "Normal", true));
  await waitFor(() => expect(hook.result.current.state.kind).toBe("ready"));
  act(() => {
    void hook.result.current.togglePlay();
  });
  await waitFor(() => expect(pythonClient.freeStorageBytes).toHaveBeenCalled());
  return hook;
};

describe("karaoke recording ownership", () => {
  it("starts rehearsal without allocating or starting a recording", async () => {
    const { result } = renderHook(() =>
      useKaraokeSession("song", "Rehearsal" as never, true),
    );
    await waitFor(() => expect(result.current.state.kind).toBe("playing"));
    expect(recordingCoordinator.start).not.toHaveBeenCalled();
    expect(audioClient.play).toHaveBeenCalledOnce();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    roomState.room = null;
    monitoringPreference.enabled = false;
    monitoringPreference.microphoneReady = true;
    vi.mocked(recordingCoordinator.start).mockResolvedValue({
      recording: true,
    });
    vi.mocked(recordingCoordinator.stop).mockResolvedValue({
      recording: false,
      recordingId: "take",
    });
    vi.mocked(pythonClient.freeStorageBytes).mockResolvedValue(1e9);
  });
  afterEach(() => cleanup());

  it("keeps the song at its starting position while disk preflight is pending", async () => {
    let release: (() => void) | undefined;
    vi.mocked(pythonClient.freeStorageBytes).mockReturnValueOnce(
      new Promise((resolve) => {
        release = () => resolve(1e9);
      }),
    );
    const { result } = await startSession();
    expect(audioClient.play).not.toHaveBeenCalled();
    expect(result.current.state.kind).toBe("ready");
    await act(async () => {
      release?.();
    });
    await waitFor(() => expect(result.current.state.kind).toBe("playing"));
    expect(recordingCoordinator.start).toHaveBeenCalledWith(
      expect.objectContaining({ id: "song" }),
      { sourceSeconds: 0, playbackRate: 1, keyShift: 0 },
    );
    expect(
      vi.mocked(recordingCoordinator.start).mock.invocationCallOrder[0],
    ).toBeLessThan(
      Number(vi.mocked(audioClient.play).mock.invocationCallOrder[0]),
    );
  });

  it("waits for the actual recording target allocation and native Start before Play", async () => {
    const actual = await vi.importActual<
      typeof import("../../services/recordingCoordinator")
    >("../../services/recordingCoordinator");
    let allocate: (() => void) | undefined;
    const pythonRequest = vi.fn(async (request: PythonBridgeRequest) => {
      if (request.path === "/recordings/target")
        await new Promise<void>((resolve) => {
          allocate = resolve;
        });
      return {
        ok: true,
        status: 200,
        body: { recordingId: "take", filePath: "D:/take.wav" },
      };
    });
    const audioRequest = vi.fn(async ({ command }: AudioBridgeRequest) => ({
      status: 0,
      text:
        command === "GetRecordingState"
          ? JSON.stringify({
              sampleRate: 48000,
              channels: 2,
              durationFrames: 0,
              startSessionFrame: 0,
              stopSessionFrame: 0,
              startPlaybackPosition: 0,
              overrunCount: 0,
              gapMetadataDropped: 0,
              staleBlocks: 0,
              gaps: [],
            })
          : "Ok",
    }));
    Object.assign(window, { desktop: { pythonRequest, audioRequest } });
    vi.mocked(recordingCoordinator.start).mockImplementationOnce(
      actual.recordingCoordinator.start,
    );
    try {
      const { result } = await startSession();
      await waitFor(() => expect(allocate).toBeDefined());
      expect(audioClient.play).not.toHaveBeenCalled();
      await act(async () => {
        allocate?.();
      });
      await waitFor(() => expect(result.current.state.kind).toBe("playing"));
      expect(
        audioRequest.mock.calls.map(([request]) => request.command),
      ).toEqual(["PrepareRecording", "StartRecording"]);
      expect(audioRequest.mock.invocationCallOrder.at(-1)).toBeLessThan(
        Number(vi.mocked(audioClient.play).mock.invocationCallOrder[0]),
      );
    } finally {
      allocate?.();
      await actual.recordingCoordinator.stop();
      Reflect.deleteProperty(window, "desktop");
    }
  });

  it.each(["disk", "prepare"])(
    "does not play after recording %s fails",
    async (stage) => {
      if (stage === "disk")
        vi.mocked(pythonClient.freeStorageBytes).mockRejectedValueOnce(
          new Error("disk unavailable"),
        );
      else
        vi.mocked(recordingCoordinator.start).mockRejectedValueOnce(
          new Error("native prepare failed"),
        );
      const { result } = await startSession();
      await waitFor(() => expect(result.current.recording).toBe("failed"));
      expect(audioClient.play).not.toHaveBeenCalled();
      expect(result.current.state.kind).toBe("ready");
    },
  );

  it("does not duplicate pending recording preflight after repeated Play clicks", async () => {
    let release: (() => void) | undefined;
    vi.mocked(pythonClient.freeStorageBytes).mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve(1e9);
      }),
    );
    const { result } = await startSession();
    act(() => {
      void result.current.togglePlay();
      void result.current.togglePlay();
    });
    try {
      expect(pythonClient.freeStorageBytes).toHaveBeenCalledOnce();
    } finally {
      await act(async () => {
        release?.();
      });
    }
  });

  it("finalizes the armed recording if Play fails after recording starts", async () => {
    vi.mocked(audioClient.play).mockRejectedValueOnce(new Error("play failed"));
    const { result } = await startSession();
    await waitFor(() => expect(result.current.state.kind).toBe("failed"));
    expect(recordingCoordinator.start).toHaveBeenCalledOnce();
    expect(recordingCoordinator.stop).toHaveBeenCalledOnce();
    expect(audioClient.stop).toHaveBeenCalledOnce();
  });

  it("does not stop the next route after an unmounted route's Play rejects", async () => {
    let rejectPlay: ((error: Error) => void) | undefined;
    vi.mocked(audioClient.play).mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectPlay = reject;
      }),
    );
    const previous = await startSession();
    await waitFor(() => expect(audioClient.play).toHaveBeenCalledOnce());
    previous.unmount();
    await waitFor(() =>
      expect(recordingCoordinator.stop).toHaveBeenCalledOnce(),
    );
    const next = await startSession();
    await waitFor(() => expect(next.result.current.state.kind).toBe("playing"));
    expect(audioClient.stop).toHaveBeenCalledOnce();

    await act(async () => {
      rejectPlay?.(new Error("old Play reply failed"));
    });

    expect(recordingCoordinator.stop).toHaveBeenCalledOnce();
    expect(audioClient.stop).toHaveBeenCalledOnce();
    expect(next.result.current.recording).toBe("recording");
  });

  it("keeps a completed Stop after its outstanding Play rejects", async () => {
    let rejectPlay: ((error: Error) => void) | undefined;
    vi.mocked(audioClient.play).mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectPlay = reject;
      }),
    );
    const { result } = await startSession();
    await waitFor(() => expect(audioClient.play).toHaveBeenCalledOnce());
    await act(async () => {
      await result.current.finishPerformance();
    });
    expect(result.current.state.kind).toBe("finished");

    await act(async () => {
      rejectPlay?.(new Error("cancelled Play reply failed"));
    });

    expect(result.current.state.kind).toBe("finished");
    expect(recordingCoordinator.stop).toHaveBeenCalledOnce();
  });

  it("does not resume a recovered session after its old Play resolves", async () => {
    let resolvePlay: (() => void) | undefined;
    vi.mocked(audioClient.play).mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePlay = () => resolve(undefined as never);
      }),
    );
    const { result } = await startSession();
    await waitFor(() => expect(audioClient.play).toHaveBeenCalledOnce());
    act(() => {
      vi.mocked(usePositionPolling).mock.calls.at(-1)?.[0].onLost();
    });
    act(() => {
      vi.mocked(useAudioRecovery).mock.calls.at(-1)?.[0].onRecovered();
    });
    expect(result.current.state.kind).toBe("paused");

    await act(async () => {
      resolvePlay?.();
    });

    expect(result.current.state.kind).toBe("paused");
    expect(recordingCoordinator.stop).not.toHaveBeenCalled();
  });

  it("does not unload the next route when old Play failure cleanup finishes saving", async () => {
    let finishSaving: (() => void) | undefined;
    vi.mocked(audioClient.play).mockRejectedValueOnce(new Error("Play failed"));
    vi.mocked(recordingCoordinator.stop).mockReturnValueOnce(
      new Promise((resolve) => {
        finishSaving = () =>
          resolve({ recording: false, recordingId: "old-take" });
      }),
    );
    const previous = await startSession();
    await waitFor(() =>
      expect(recordingCoordinator.stop).toHaveBeenCalledOnce(),
    );
    previous.unmount();
    const next = renderHook(() =>
      useKaraokeSession("next-song", "Normal", true),
    );
    await waitFor(() => expect(next.result.current.state.kind).toBe("ready"));
    expect(audioClient.stop).toHaveBeenCalledOnce();

    await act(async () => {
      finishSaving?.();
    });

    expect(audioClient.stop).toHaveBeenCalledOnce();
  });

  it("applies every displayed mixer value when the native karaoke session becomes ready", async () => {
    let releaseFirst!: () => void;
    vi.mocked(audioClient.setMixer)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = () => resolve(undefined);
          }),
      )
      .mockResolvedValue(undefined);
    renderHook(() => useKaraokeSession("song", "Normal", true));

    await waitFor(() => expect(audioClient.setMixer).toHaveBeenCalledOnce());
    expect(audioClient.setMixer).toHaveBeenLastCalledWith("music", 0.42);
    await act(async () => {
      releaseFirst();
    });
    await waitFor(() => expect(audioClient.setMixer).toHaveBeenCalledTimes(5));
    expect(vi.mocked(audioClient.setMixer).mock.calls).toEqual([
      ["music", 0.42],
      ["mic", 0.53],
      ["reference", 0.64],
      ["melody", 0.75],
      ["master", 0.86],
    ]);
  });

  it("restores the saved monitoring choice after leaving and opening another song", async () => {
    monitoringPreference.enabled = true;
    const first = renderHook(() => useKaraokeSession("song", "Normal", true));
    await waitFor(() => expect(first.result.current.monitoring).toBe(true));
    expect(audioClient.setMonitoring).toHaveBeenLastCalledWith(true);
    first.unmount();
    expect(audioClient.setMonitoring).toHaveBeenLastCalledWith(false);

    const { result } = renderHook(() =>
      useKaraokeSession("next-song", "Normal", true),
    );
    await waitFor(() => expect(result.current.monitoring).toBe(true));
    expect(audioClient.setMonitoring).toHaveBeenLastCalledWith(true);
  });

  it.each([false, true])(
    "keeps monitoring off without an enabled preference and ready microphone (%s)",
    async (enabled) => {
      monitoringPreference.enabled = enabled;
      monitoringPreference.microphoneReady = !enabled;
      const { result } = renderHook(() =>
        useKaraokeSession("song", "Normal", true),
      );
      await waitFor(() => expect(result.current.state.kind).toBe("ready"));
      await waitFor(() =>
        expect(audioClient.setMixer).toHaveBeenCalledTimes(5),
      );
      expect(audioClient.setMonitoring).not.toHaveBeenCalledWith(true);
      expect(result.current.monitoring).toBe(false);
    },
  );

  it("does not fail karaoke or retry when restoring monitoring is rejected", async () => {
    monitoringPreference.enabled = true;
    vi.mocked(audioClient.setMonitoring).mockRejectedValueOnce(
      new Error("Monitoring unavailable"),
    );
    const { result, rerender } = renderHook(() =>
      useKaraokeSession("song", "Normal", true),
    );
    await waitFor(() => expect(monitoringWarning).toHaveBeenCalledOnce());
    expect(result.current.state.kind).toBe("ready");
    expect(result.current.monitoring).toBe(false);
    rerender();
    expect(audioClient.setMonitoring).toHaveBeenCalledOnce();
  });

  it("shows one error when native monitoring protection disconnects the speaker", async () => {
    monitoringPreference.enabled = true;
    const { result, rerender } = renderHook(() =>
      useKaraokeSession("song", "Normal", true),
    );
    await waitFor(() => expect(result.current.monitoring).toBe(true));
    const onSnapshot = vi
      .mocked(usePositionPolling)
      .mock.calls.at(-1)?.[0].onSnapshot;
    expect(onSnapshot).toBeDefined();
    const snapshot = {
      monitoring: false,
      monitoringSafetyTripped: true,
      pitchHz: undefined,
    } as never;
    act(() => {
      onSnapshot?.(snapshot);
      onSnapshot?.(snapshot);
    });
    expect(monitoringWarning).toHaveBeenCalledTimes(1);
    expect(monitoringWarning).toHaveBeenCalledWith(
      "Мониторинг микрофона отключён: входной сигнал долго оставался слишком громким. Уменьшите громкость колонок или используйте наушники перед повторным включением.",
      "error",
    );
    rerender();
    expect(result.current.monitoring).toBe(false);
    expect(audioClient.setMonitoring).toHaveBeenCalledOnce();
  });

  it("lets a guest save and leave without asking or permission to stop the room", async () => {
    dialogs.ask.mockResolvedValue("save");
    const { result, rerender } = await startSession();
    await waitFor(() => expect(result.current.recording).toBe("recording"));
    roomState.room = {
      code: "room",
      hostId: "host",
      role: "participant",
      songId: "song",
      participants: [],
      playbackLocked: false,
      collaborativeControl: false,
    };
    rerender();
    let allowed = false;
    await act(async () => {
      allowed = await result.current.confirmExit();
    });
    expect(allowed).toBe(true);
    expect(recordingCoordinator.stop).toHaveBeenCalledOnce();
    expect(dialogs.ask).not.toHaveBeenCalled();
  });

  it("keeps the route open when saving fails and permits a successful retry", async () => {
    dialogs.ask.mockResolvedValue("save");
    vi.mocked(recordingCoordinator.stop).mockRejectedValueOnce(
      new Error("disk unavailable"),
    );
    const { result } = await startSession();
    await waitFor(() => expect(result.current.recording).toBe("recording"));
    let allowed = true;
    await act(async () => {
      allowed = await result.current.confirmExit();
    });
    expect(allowed).toBe(false);
    expect(result.current.recording).toBe("failed");
    await act(async () => {
      allowed = await result.current.confirmExit();
    });
    expect(allowed).toBe(true);
    expect(recordingCoordinator.stop).toHaveBeenCalledTimes(2);
  });

  it("cannot start recording after Stop overtakes disk preflight", async () => {
    let finishPreflight: (() => void) | undefined;
    vi.mocked(pythonClient.freeStorageBytes).mockReturnValue(
      new Promise((resolve) => {
        finishPreflight = () => resolve(1e9);
      }),
    );
    const { result } = await startSession();
    await act(async () => {
      const finished = result.current.finishPerformance();
      finishPreflight?.();
      await finished;
    });
    expect(recordingCoordinator.start).not.toHaveBeenCalled();
  });

  it("invalidates pending recording preflight when the audio device is lost", async () => {
    let finishPreflight: (() => void) | undefined;
    vi.mocked(pythonClient.freeStorageBytes).mockReturnValue(
      new Promise((resolve) => {
        finishPreflight = () => resolve(1e9);
      }),
    );
    const { result } = await startSession();
    await act(async () => {
      vi.mocked(usePositionPolling).mock.calls.at(-1)?.[0].onLost();
    });
    expect(result.current.state.kind).toBe("recovering");
    await act(async () => {
      vi.mocked(useAudioRecovery).mock.calls.at(-1)?.[0].onRecovered();
      finishPreflight?.();
    });
    expect(recordingCoordinator.start).not.toHaveBeenCalled();
    expect(result.current.recording).toBe("failed");
  });

  it("finalizes a native start that was still pending when Stop arrived", async () => {
    let started: (() => void) | undefined;
    vi.mocked(recordingCoordinator.start).mockReturnValue(
      new Promise((resolve) => {
        started = () => resolve({ recording: true });
      }),
    );
    const { result } = await startSession();
    await waitFor(() =>
      expect(recordingCoordinator.start).toHaveBeenCalledOnce(),
    );
    await act(async () => {
      const finished = result.current.finishPerformance();
      started?.();
      await finished;
    });
    expect(recordingCoordinator.stop).toHaveBeenCalledOnce();
    expect(result.current.recording).toBe("idle");
    expect(result.current.recordingId).toBe("take");
  });

  it("finishes a saved take and exposes its recording id", async () => {
    const { result } = await startSession();
    await waitFor(() => expect(result.current.recording).toBe("recording"));
    const finishing = result.current.finishPerformance();

    await waitFor(() => expect(result.current.state.kind).toBe("finished"), {
      timeout: 500,
    });
    await finishing;
    expect(result.current.recordingId).toBe("take");
  });

  it("does not record after its route unmounts while disk preflight is pending", async () => {
    let finishPreflight: (() => void) | undefined;
    vi.mocked(pythonClient.freeStorageBytes).mockReturnValue(
      new Promise((resolve) => {
        finishPreflight = () => resolve(1e9);
      }),
    );
    const { unmount } = await startSession();
    unmount();
    await act(async () => {
      finishPreflight?.();
    });
    expect(recordingCoordinator.start).not.toHaveBeenCalled();
  });
});

vi.mock("../../providers/store", () => ({ store: {
  get online() { return { room: roomState.room }; },
  get preferences() { return {
      musicGain: 0.42,
      voiceGain: 0.53,
      referenceGain: 0.64,
      melodyGain: 0.75,
      masterGain: 0.86,
      karaokeMonitoring: monitoringPreference.enabled,
      keyboardLighting: false,
      theme: "dark",
    }; },
  get updatePreferences() { return vi.fn(); },
  get openSettings() { return vi.fn(); }
} }));
