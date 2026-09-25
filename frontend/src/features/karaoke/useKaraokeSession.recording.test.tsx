import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKaraokeSession } from "./useKaraokeSession";
import { recordingCoordinator } from "../../services/recordingCoordinator";
import { pythonClient } from "../../services/pythonClient";

const dialogs = vi.hoisted(() => ({ ask: vi.fn() }));
vi.mock("../../app/AppContext", () => ({ useApp: () => ({ preferences: {}, updatePreferences: vi.fn(), openSettings: vi.fn() }) }));
vi.mock("../../app/DialogProvider", () => ({ useAsk: () => dialogs.ask }));
vi.mock("../../app/CloseGuards", () => ({ useCloseGuard: vi.fn() }));
vi.mock("../../app/NotificationsProvider", () => ({ useNotify: () => vi.fn() }));
vi.mock("../../i18n/useText", () => ({ useText: () => (key: string) => key }));
vi.mock("../../services/pythonClient", () => ({ pythonClient: { diagnostics: vi.fn() } }));
vi.mock("../../services/audioClient", () => ({ audioClient: {
  play: vi.fn(async () => undefined), stop: vi.fn(async () => undefined),
  setMonitoring: vi.fn(async () => undefined), setDspEnabled: vi.fn(async () => undefined)
} }));
vi.mock("../../services/recordingCoordinator", () => ({ recordingCoordinator: { start: vi.fn(), stop: vi.fn(), hasPendingTake: () => true } }));
vi.mock("./performanceAnalysis", () => ({ ensurePerformanceAnalysis: vi.fn(async () => null) }));
vi.mock("./usePositionPolling", () => ({ usePositionPolling: () => ({ invalidate: vi.fn() }) }));
vi.mock("./useAudioRecovery", () => ({ useAudioRecovery: vi.fn() }));
vi.mock("./useKeyboardLighting", () => ({ useKeyboardLighting: vi.fn() }));
vi.mock("./useKaraokeControls", () => ({ useKaraokeControls: () => ({}) }));
vi.mock("./useSynchronizedRoomPlayback", () => ({ useSynchronizedRoomPlayback: vi.fn() }));
vi.mock("./useKaraokeLoadSession", async () => {
  const { useEffect } = await import("react");
  const song = { id: "song", activeRevision: 1 };
  return { useKaraokeLoadSession: (_id: string, _mode: string, _gains: unknown, prepared: () => void) => {
    useEffect(() => { prepared(); }, []);
    return { load: { kind: "ready", song }, capabilities: { microphone: "ready" } };
  } };
});

const startSession = async () => {
  const hook = renderHook(() => useKaraokeSession("song", "Normal", true));
  await waitFor(() => expect(hook.result.current.state.kind).toBe("ready"));
  await act(() => hook.result.current.togglePlay());
  return hook;
};

describe("karaoke recording ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(recordingCoordinator.start).mockResolvedValue({ recording: true });
    vi.mocked(recordingCoordinator.stop).mockResolvedValue({ recording: false, recordingId: "take" });
    vi.mocked(pythonClient.diagnostics).mockResolvedValue({ storage: { free: 1e9 } } as never);
  });
  afterEach(() => cleanup());

  it("keeps the route open when saving fails and permits a successful retry", async () => {
    dialogs.ask.mockResolvedValue("save");
    vi.mocked(recordingCoordinator.stop).mockRejectedValueOnce(new Error("disk unavailable"));
    const { result } = await startSession();
    await waitFor(() => expect(result.current.recording).toBe("recording"));
    let allowed = true;
    await act(async () => { allowed = await result.current.confirmExit(); });
    expect(allowed).toBe(false);
    expect(result.current.recording).toBe("failed");
    await act(async () => { allowed = await result.current.confirmExit(); });
    expect(allowed).toBe(true);
    expect(recordingCoordinator.stop).toHaveBeenCalledTimes(2);
  });

  it("cannot start recording after Stop overtakes disk preflight", async () => {
    let finishPreflight: (() => void) | undefined;
    vi.mocked(pythonClient.diagnostics).mockReturnValue(new Promise(resolve => {
      finishPreflight = () => resolve({ storage: { free: 1e9 } } as never);
    }));
    const { result } = await startSession();
    await act(async () => {
      const finished = result.current.finishPerformance();
      finishPreflight?.();
      await finished;
    });
    expect(recordingCoordinator.start).not.toHaveBeenCalled();
  });

  it("finalizes a native start that was still pending when Stop arrived", async () => {
    let started: (() => void) | undefined;
    vi.mocked(recordingCoordinator.start).mockReturnValue(new Promise(resolve => {
      started = () => resolve({ recording: true });
    }));
    const { result } = await startSession();
    await waitFor(() => expect(recordingCoordinator.start).toHaveBeenCalledOnce());
    await act(async () => {
      const finished = result.current.finishPerformance();
      started?.();
      await finished;
    });
    expect(recordingCoordinator.stop).toHaveBeenCalledOnce();
    expect(result.current.recording).toBe("idle");
    expect(result.current.recordingId).toBe("take");
  });

  it("does not record after its route unmounts while disk preflight is pending", async () => {
    let finishPreflight: (() => void) | undefined;
    vi.mocked(pythonClient.diagnostics).mockReturnValue(new Promise(resolve => {
      finishPreflight = () => resolve({ storage: { free: 1e9 } } as never);
    }));
    const { unmount } = await startSession();
    unmount();
    await act(async () => { finishPreflight?.(); });
    expect(recordingCoordinator.start).not.toHaveBeenCalled();
  });
});
