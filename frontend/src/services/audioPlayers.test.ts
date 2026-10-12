import { describe, expect, it, vi } from "vitest";
import { createAudioPlayers, type AudioPlayerOperations } from "./audioPlayers";

const setup = () => {
  const command = vi.fn<AudioPlayerOperations["command"]>().mockResolvedValue("");
  const pythonRequest = vi.fn<AudioPlayerOperations["pythonRequest"]>().mockResolvedValue({
    ok: true, status: 200, body: { filePath: "test-recording.wav" },
  });
  const diagnostics = vi.fn<AudioPlayerOperations["diagnostics"]>()
    .mockResolvedValue({ PreviewState: "2", RuntimeOutputSampleRate: "48000" });
  const players = createAudioPlayers({
    command, pythonRequest,
    ensureSession: async () => undefined,
    diagnostics,
    sampleRate: async () => 48000,
    snapshot: async (state) => ({
      state, sessionId: "test", positionSeconds: 0, durationSeconds: 60,
      recording: false, monitoring: false, inputLevel: 0,
    }),
  });
  return { players, command, pythonRequest, diagnostics };
};

describe("recording preview ownership", () => {
  it("hands a playing take to another player without an invalid duplicate native Play", async () => {
    const { players, command, diagnostics } = setup();
    await players.playRecording("take", Symbol("first"));
    diagnostics.mockResolvedValue({ PreviewState: "3", RuntimeOutputSampleRate: "48000" });
    command.mockImplementation(async (name) => {
      if (name === "PlayRecordingPreview") throw new Error("Playback is not prepared");
      return "";
    });
    const second = Symbol("second");

    await expect(players.playRecording("take", second)).resolves.toMatchObject({ state: "playing" });
    expect(command.mock.calls.filter(([name]) => name === "PlayRecordingPreview")).toHaveLength(1);
    expect((await players.recordingPreviewStatus(second)).recordingId).toBe("take");
  });
  it("ignores controls and cleanup from a player replaced by another player of the same take", async () => {
    const { players, command } = setup();
    const first = Symbol("first");
    const second = Symbol("second");
    await players.playRecording("take", first);
    await players.pauseRecordingPreview(first);
    await players.playRecording("take", second);
    command.mockClear();

    await players.pauseRecordingPreview(first);
    await players.seekRecordingPreview(12, first);
    await players.stopRecordingPreview(first);

    expect(command).not.toHaveBeenCalled();
    expect((await players.recordingPreviewStatus(first)).recordingId).toBeNull();
    expect((await players.recordingPreviewStatus(second)).recordingId).toBe("take");
  });

  it.each(["stop", "replace"])("does not play an obsolete load after %s", async (operation) => {
    const { players, command, pythonRequest } = setup();
    const first = Symbol("first");
    const second = Symbol("second");
    let finish!: (reply: Awaited<ReturnType<AudioPlayerOperations["pythonRequest"]>>) => void;
    pythonRequest.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const loading = players.playRecording("first", first);
    const outcome = loading.then(() => "played", () => "cancelled");
    await vi.waitFor(() => expect(pythonRequest).toHaveBeenCalledOnce());
    if (operation === "stop") await players.stopRecordingPreview(first);
    else await players.playRecording("second", second);
    command.mockClear();
    finish({ ok: true, status: 200, body: { filePath: "first.wav" } });

    expect(await outcome).toBe("cancelled");
    expect(command).not.toHaveBeenCalled();
  });
});
