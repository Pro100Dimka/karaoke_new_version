import type { AudioServiceClient } from "../contracts/clients";
import type { PlaybackSnapshot } from "../contracts/models";

/** What the radio and the recording preview need from the audio client they belong to. */
export interface AudioPlayerOperations {
  command(name: string, args?: Record<string, unknown>): Promise<string>;
  diagnostics(): Promise<Record<string, string>>;
  ensureSession(): Promise<void>;
  snapshot(state: PlaybackSnapshot["state"]): Promise<PlaybackSnapshot>;
  pythonRequest: DesktopApi["pythonRequest"];
  sampleRate(): Promise<number>;
}

type AudioPlayers = Pick<AudioServiceClient,
  | "loadRadio" | "playRadio" | "pauseRadio" | "stopRadio" | "setRadioGain" | "playRecording"
  | "pauseRecordingPreview" | "seekRecordingPreview" | "stopRecordingPreview" | "setPreviewVolume"
  | "recordingPreviewStatus">;

// PlaybackState numbers AudioService reports for the radio and the recording preview slots.
const readyState = 2;
const playingState = 3;
const pausedState = 4;
const finishedState = 6;
const failedState = 7;
const previewStates: Record<number, "ready" | "playing" | "paused" | "finished"> = {
  [readyState]: "ready", [playingState]: "playing", [pausedState]: "paused", [finishedState]: "finished",
};
const pollAttempts = 100;
const previewPollMilliseconds = 25;
const radioPollMilliseconds = 100;
const wait = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

/** The two players outside karaoke: the internet radio and the preview of a saved recording. */
export const createAudioPlayers = (ops: AudioPlayerOperations): AudioPlayers => {
  let previewRecordingId: string | null = null;

  const waitFor = async (field: string, ready: readonly number[], interval: number, what: string) => {
    for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
      const state = Number((await ops.diagnostics())[field] ?? 0);
      if (state === failedState) throw new Error(`AudioService could not open the ${what}`);
      if (ready.includes(state)) return;
      await wait(interval);
    }
    throw new Error(`AudioService ${what} timed out`);
  };

  return {
    async loadRadio(url) {
      await ops.ensureSession();
      await ops.command("LoadRadioStation", { url });
      await waitFor("RadioState", [readyState], radioPollMilliseconds, "radio stream");
    },
    async playRadio() {
      await ops.command("PlayRadio");
    },
    async pauseRadio() {
      await ops.command("PauseRadio");
    },
    async stopRadio() {
      await ops.command("StopRadio");
    },
    async setRadioGain(gain) {
      await ops.command("SetRadioGain", { value: gain });
    },
    async playRecording(recordingId) {
      await ops.ensureSession();
      const response = await ops.pythonRequest({
        method: "GET",
        path: `/recordings/${encodeURIComponent(recordingId)}`,
      });
      if (!response.ok || !response.body || typeof response.body !== "object")
        throw new Error("Recording not found");
      const filePath = (response.body as Record<string, unknown>).filePath;
      if (typeof filePath !== "string")
        throw new Error("Recording file path is invalid");
      const finished = Number((await ops.diagnostics()).PreviewState ?? 0) === finishedState;
      if (previewRecordingId !== recordingId || finished) {
        await ops.command("LoadRecordingPreview", { path: filePath });
        await waitFor("PreviewState", [readyState, playingState, pausedState], previewPollMilliseconds, "recording");
        previewRecordingId = recordingId;
      }
      await ops.command("PlayRecordingPreview");
      return ops.snapshot("playing");
    },
    async pauseRecordingPreview() {
      await ops.command("PauseRecordingPreview");
    },
    async seekRecordingPreview(positionSeconds) {
      const frame = Math.max(0, Math.round(positionSeconds * (await ops.sampleRate())));
      await ops.command("SeekRecordingPreview", { frame });
    },
    async stopRecordingPreview() {
      await ops.command("StopRecordingPreview");
    },
    async setPreviewVolume(gain) {
      await ops.command("SetGain", { target: "preview", value: gain });
    },
    async recordingPreviewStatus() {
      const values = await ops.diagnostics();
      const sampleRate = Number(values.RuntimeOutputSampleRate || values.RequestedSampleRate || 0) || 0;
      const stateNumber = Number(values.PreviewState ?? readyState);
      return {
        recordingId: previewRecordingId,
        state: previewStates[stateNumber] ?? "ready",
        positionSeconds: sampleRate > 0 ? (Number(values.PreviewPositionFrames || 0) || 0) / sampleRate : 0,
      };
    },
  };
};
