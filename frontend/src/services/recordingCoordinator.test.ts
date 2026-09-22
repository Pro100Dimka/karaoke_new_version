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
        }))
      }
    });

    await recordingCoordinator.start({ id: "song-1", activeRevision: 3 } as SongDto);

    expect(audioRequest).toHaveBeenCalledWith({
      command: "PrepareRecording",
      args: { id: "take-1", path: "D:/take-1.wav", tap: "performance" }
    });
  });
});
