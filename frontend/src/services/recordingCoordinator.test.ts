import { afterEach, describe, expect, it, vi } from "vitest";
import type { SongDto } from "../contracts/models";
import { recordingCoordinator } from "./recordingCoordinator";

describe("recordingCoordinator", () => {
  afterEach(() => Reflect.deleteProperty(window, "desktop"));

  it("records the audible master mix so playback contains the song and the configured voice", async () => {
    const audioRequest = vi.fn(async (request: AudioBridgeRequest) => ({
      status: 0,
      text: request.command === "GetDiagnostics"
        ? "PlaybackState: 2\nPlaybackPositionFrames: 0\nRuntimeOutputSampleRate: 48000"
        : "Ok"
    }));
    Object.assign(window, {
      desktop: {
        audioRequest,
        pythonRequest: vi.fn(async () => ({
          ok: true,
          status: 200,
          body: { recordingId: "take-1", filePath: "D:/take-1.wav" }
        })),
        inspectWave: vi.fn(async () => ({ durationSeconds: 1, sampleRate: 48000, channels: 2 }))
      }
    });

    await recordingCoordinator.start({ id: "song-1", activeRevision: 3 } as SongDto);

    expect(audioRequest).toHaveBeenCalledWith({
      command: "PrepareRecording",
      args: { id: "take-1", path: "D:/take-1.wav", tap: "performance" }
    });
    await recordingCoordinator.stop();
  });

  it("stores the runtime tempo and key timeline with the take", async () => {
    const pythonRequest = vi.fn(async (request: PythonBridgeRequest) => ({
      ok: true,
      status: 200,
      body: request.path === "/recordings/target"
        ? { recordingId: "take-transform", filePath: "D:/take-transform.wav" }
        : {}
    }));
    Object.assign(window, {
      desktop: {
        audioRequest: vi.fn(async (request: AudioBridgeRequest) => ({
          status: 0,
          text: request.command === "StopRecording" ? "D:/take-transform.wav" : "Ok"
        })),
        pythonRequest,
        inspectWave: vi.fn(async () => ({ durationSeconds: 3, sampleRate: 48000, channels: 2 }))
      }
    });

    await recordingCoordinator.start(
      { id: "song-1", activeRevision: 3 } as SongDto,
      { sourceSeconds: 4, playbackRate: 0.9, keyShift: -1 }
    );
    recordingCoordinator.updatePlaybackAdjustment({ sourceSeconds: 5, playbackRate: 1.1, keyShift: 2 });
    await recordingCoordinator.stop();

    const register = pythonRequest.mock.calls.find(([request]) => request.path === "/recordings")?.[0];
    expect(register?.body).toMatchObject({
      sessionMetadata: {
        playbackAdjustments: [
          { elapsedSeconds: 0, sourceSeconds: 4, playbackRate: 0.9, keyShift: -1 },
          { sourceSeconds: 5, playbackRate: 1.1, keyShift: 2 }
        ]
      }
    });
  });
});
