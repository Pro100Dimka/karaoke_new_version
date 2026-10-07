import type { SongDto } from "../../contracts/models";
import type {
  KaraokeAudioPort, KaraokeBackendPort, KaraokeRecordingPort,
  PlaybackAdjustment,
} from "./KaraokePorts";

export const minimumRecordingBytes = 200 * 1024 * 1024;

export type RecordingStart =
  | { kind: "started" }
  | { kind: "insufficientDisk"; free: number; generation: number }
  | { kind: "cancelled" }
  | { kind: "failed" };

/** Owns recording preflight and cancellation for one local karaoke route. */
export class KaraokeRecordingCoordinator {
  private generation = 0;

  constructor(
    private readonly backend: Pick<KaraokeBackendPort, "diagnostics">,
    private readonly recording: KaraokeRecordingPort,
    private readonly audio: Pick<KaraokeAudioPort, "stop">,
  ) {}

  invalidate(): void { this.generation++; }
  isCurrent(generation: number): boolean { return generation === this.generation; }

  async start(song: SongDto, adjustment: PlaybackAdjustment): Promise<RecordingStart> {
    const generation = this.generation;
    try {
      const free = (await this.backend.diagnostics()).storage.free;
      if (!this.isCurrent(generation)) return { kind: "cancelled" };
      if (free < minimumRecordingBytes)
        return { kind: "insufficientDisk", free, generation };
      await this.recording.start(song, adjustment);
      return this.isCurrent(generation) ? { kind: "started" } : { kind: "cancelled" };
    } catch {
      return this.isCurrent(generation) ? { kind: "failed" } : { kind: "cancelled" };
    }
  }

  async finish(): Promise<{ saved: boolean; recordingId?: string }> {
    this.invalidate();
    let recordingId: string | undefined;
    let saved = true;
    try {
      recordingId = (await this.recording.stop()).recordingId;
    } catch {
      saved = false;
    }
    await this.audio.stop().catch(() => undefined);
    return { saved, recordingId };
  }
}
