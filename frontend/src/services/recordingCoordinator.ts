import type { SongDto } from "../contracts/models";
import { getAudioSnapshot } from "./audioClient";

interface RecordingTarget { recordingId: string; filePath: string; }
let active: { target: RecordingTarget; song: SongDto } | null = null;

const desktop = (): DesktopApi => {
  if (!window.desktop) throw new Error("Desktop bridge is unavailable");
  return window.desktop;
};

const python = async <T>(request: PythonBridgeRequest): Promise<T> => {
  const response = await desktop().pythonRequest(request);
  if (!response.ok) throw new Error("Python backend request failed");
  return response.body as T;
};

const audio = async (command: string, args?: AudioBridgeRequest["args"]): Promise<string> => {
  const response = await desktop().audioRequest({ command, args });
  if (response.status !== 0) throw new Error(response.text || `AudioService command failed: ${command}`);
  return response.text;
};

export const recordingCoordinator = {
  async start(song: SongDto) {
    if (active) return { ...(await getAudioSnapshot()), recording: true };
    const target = await python<RecordingTarget>({ method: "POST", path: "/recordings/target" });
    await audio("PrepareRecording", { id: target.recordingId, path: target.filePath, tap: "performance" });
    await audio("StartRecording");
    active = { target, song };
    return { ...(await getAudioSnapshot()), recording: true };
  },

  async stop() {
    if (!active) return { ...(await getAudioSnapshot()), recording: false, recordingId: undefined };
    const current = active;
    const filePath = await audio("StopRecording");
    const info = await desktop().inspectWave(filePath || current.target.filePath);
    await python({
      method: "POST",
      path: "/recordings",
      headers: { "Idempotency-Key": current.target.recordingId },
      body: {
        recordingId: current.target.recordingId,
        filePath: filePath || current.target.filePath,
        duration: Math.max(info.durationSeconds, 0.001),
        sampleRate: info.sampleRate,
        channels: info.channels,
        createdAt: new Date().toISOString(),
        songId: current.song.id,
        songRevision: current.song.activeRevision,
        gaps: [],
        sessionMetadata: {}
      }
    });
    active = null;
    return { ...(await getAudioSnapshot()), recording: false, recordingId: current.target.recordingId };
  }
};
