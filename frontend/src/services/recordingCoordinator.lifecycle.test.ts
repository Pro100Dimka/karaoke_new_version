import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SongDto } from "../contracts/models";

const song = { id: "song", activeRevision: 1 } as SongDto;
const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const setup = async () => {
  const audioRequest = vi.fn(async (request: AudioBridgeRequest) => ({
    status: 0, text: request.command === "StopRecording" ? "D:/take.wav" : "Ok"
  }));
  const pythonRequest = vi.fn(async (request: PythonBridgeRequest) => ({
    ok: true, status: 200,
    body: request.path === "/recordings/target" ? { recordingId: "take", filePath: "D:/take.wav" } : {}
  }));
  Object.assign(window, { desktop: {
    audioRequest, pythonRequest,
    inspectWave: vi.fn(async () => ({ durationSeconds: 1, sampleRate: 44100, channels: 1 }))
  } });
  const { recordingCoordinator } = await import("./recordingCoordinator");
  return { recordingCoordinator, audioRequest, pythonRequest };
};

describe("recording lifecycle", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => Reflect.deleteProperty(window, "desktop"));

  it("prepares one file for concurrent starts and finalizes once for concurrent stops", async () => {
    const { recordingCoordinator: coordinator, audioRequest, pythonRequest } = await setup();
    await Promise.all([coordinator.start(song), coordinator.start(song)]);
    const results = await Promise.all([coordinator.stop(), coordinator.stop()]);
    expect(audioRequest.mock.calls.filter(([r]) => r.command === "PrepareRecording")).toHaveLength(1);
    expect(audioRequest.mock.calls.filter(([r]) => r.command === "StopRecording")).toHaveLength(1);
    expect(pythonRequest.mock.calls.filter(([r]) => r.path === "/recordings")).toHaveLength(1);
    expect(results.map(r => r.recordingId)).toEqual(["take", "take"]);
  });

  it("orders stop after an unfinished start", async () => {
    const { recordingCoordinator: coordinator, audioRequest } = await setup();
    const starting = deferred();
    audioRequest.mockImplementation(async request => {
      if (request.command === "StartRecording") await starting.promise;
      return { status: 0, text: request.command === "StopRecording" ? "D:/take.wav" : "Ok" };
    });
    const started = coordinator.start(song);
    await vi.waitFor(() => expect(audioRequest).toHaveBeenCalledWith({ command: "StartRecording", args: undefined }));
    const stopped = coordinator.stop();
    starting.resolve();
    await started;
    expect((await stopped).recordingId).toBe("take");
    expect(audioRequest.mock.calls.filter(([r]) => r.command === "StopRecording")).toHaveLength(1);
  });

  it("retries registration without stopping an already finalized native take", async () => {
    const { recordingCoordinator: coordinator, audioRequest, pythonRequest } = await setup();
    await coordinator.start(song);
    pythonRequest.mockRejectedValueOnce(new Error("backend restarted"));
    await expect(coordinator.stop()).rejects.toThrow("backend restarted");
    const saved = await coordinator.stop();
    expect(saved.recordingId).toBe("take");
    expect(audioRequest.mock.calls.filter(([r]) => r.command === "StopRecording")).toHaveLength(1);
  });

  it("does not turn a successful recording command into an error because diagnostics failed", async () => {
    const { recordingCoordinator: coordinator, audioRequest } = await setup();
    audioRequest.mockImplementation(async request => {
      if (request.command === "GetDiagnostics") throw new Error("diagnostics unavailable");
      return { status: 0, text: request.command === "StopRecording" ? "D:/take.wav" : "Ok" };
    });
    await expect(coordinator.start(song)).resolves.toMatchObject({ recording: true });
    await expect(coordinator.stop()).resolves.toMatchObject({ recording: false, recordingId: "take" });
  });
});
