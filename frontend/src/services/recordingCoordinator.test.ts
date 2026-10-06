import { afterEach, describe, expect, it, vi } from "vitest";
import type { SongDto } from "../contracts/models";
import { recordingCoordinator } from "./recordingCoordinator";

const nativeResult = (seconds: number) => JSON.stringify({
  sampleRate: 48000, channels: 2, durationFrames: seconds * 48000, startSessionFrame: 0,
  stopSessionFrame: seconds * 48000, startPlaybackPosition: 0, overrunCount: 0,
  gapMetadataDropped: 0, staleBlocks: 0, gaps: []
});

describe("recordingCoordinator", () => {
  afterEach(() => Reflect.deleteProperty(window, "desktop"));

  it("records the audible master mix so playback contains the song and the configured voice", async () => {
    const audioRequest = vi.fn(async (request: AudioBridgeRequest) => ({
      status: 0,
      text: request.command === "GetRecordingState"
        ? nativeResult(1)
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
          text: request.command === "GetRecordingState" ? nativeResult(3) :
            request.command === "StopRecording" ? "D:/take-transform.wav" : "Ok"
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

  it("stores the live green-note score with the take", async () => {
    const pythonRequest = vi.fn(async (request: PythonBridgeRequest) => ({
      ok: true, status: 200,
      body: request.path === "/recordings/target" ? { recordingId: "take-notes", filePath: "D:/take-notes.wav" } : {}
    }));
    Object.assign(window, { desktop: {
      audioRequest: vi.fn(async (request: AudioBridgeRequest) => ({
        status: 0,
        text: request.command === "GetRecordingState" ? nativeResult(1) :
          request.command === "StopRecording" ? "D:/take-notes.wav" : "Ok"
      })),
      pythonRequest,
      inspectWave: vi.fn(async () => ({ durationSeconds: 1, sampleRate: 48000, channels: 2 }))
    } });

    await recordingCoordinator.start({ id: "song-1", activeRevision: 3 } as SongDto);
    recordingCoordinator.updateKaraokeNoteScore({
      hitNotes: 3,
      totalNotes: 5,
      rhythmAccuracyPercent: 72,
      noteStabilityPercent: 88,
    });
    await recordingCoordinator.stop();

    const register = pythonRequest.mock.calls.find(([request]) => request.path === "/recordings")?.[0];
    expect(register?.body).toMatchObject({
      sessionMetadata: {
        karaokeNoteScore: {
          hitNotes: 3,
          totalNotes: 5,
          rhythmAccuracyPercent: 72,
          noteStabilityPercent: 88,
        },
      },
    });
  });

  it("keeps the song timeline of a take true across a pause, a seek and resuming elsewhere", async () => {
    let now = 1_000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const audioRequest = vi.fn(async (request: AudioBridgeRequest) => ({
      status: 0,
      text: request.command === "GetRecordingState" ? nativeResult(6) :
        request.command === "StopRecording" ? "D:/take-pause.wav" : "Ok"
    }));
    const pythonRequest = vi.fn(async (request: PythonBridgeRequest) => ({
      ok: true,
      status: 200,
      body: request.path === "/recordings/target" ? { recordingId: "take-pause", filePath: "D:/take-pause.wav" } : {}
    }));
    Object.assign(window, { desktop: {
      audioRequest,
      pythonRequest,
      inspectWave: vi.fn(async () => ({ durationSeconds: 6, sampleRate: 48000, channels: 2 }))
    } });

    await recordingCoordinator.start({ id: "song-1", activeRevision: 3 } as SongDto, { sourceSeconds: 10, playbackRate: 1, keyShift: 0 });
    now += 2_000;
    recordingCoordinator.observePosition(12.1); // ordinary polling jitter: nothing to record
    recordingCoordinator.observePosition(40); // a seek while singing
    now += 1_000;
    await recordingCoordinator.pause();
    now += 30_000; // a long pause is not part of the take
    await recordingCoordinator.resume({ sourceSeconds: 60, playbackRate: 1, keyShift: 0 });
    now += 3_000;
    await recordingCoordinator.stop();
    clock.mockRestore();

    expect(audioRequest.mock.calls.map(([request]) => request.command)).toEqual(
      expect.arrayContaining(["PauseRecording", "ResumeRecording"])
    );
    const register = pythonRequest.mock.calls.find(([request]) => request.path === "/recordings")?.[0];
    expect((register?.body as { sessionMetadata: { playbackAdjustments: unknown } }).sessionMetadata.playbackAdjustments).toEqual([
      { elapsedSeconds: 0, sourceSeconds: 10, playbackRate: 1, keyShift: 0 },
      { elapsedSeconds: 2, sourceSeconds: 40, playbackRate: 1, keyShift: 0 },
      { elapsedSeconds: 3, sourceSeconds: 60, playbackRate: 1, keyShift: 0 }
    ]);
  });
});
