import type { PlaybackSnapshot, SongDto } from "../contracts/models";

export interface MediaCheckpoint {
  song: SongDto;
  state: PlaybackSnapshot["state"];
  positionSeconds: number;
}

interface RestoreOperations {
  ensureSession(): Promise<void>;
  resolveArtifacts(song: SongDto): Promise<{
    instrumental: string;
    vocals?: string;
    melody?: string;
  }>;
  command(name: string, args?: AudioBridgeRequest["args"]): Promise<string>;
  waitForReady(): Promise<void>;
  sampleRate(): Promise<number>;
}

/** Renderer-side state that AudioService necessarily loses when its hardware backend is rebuilt. */
export class AudioReconfigurationState {
  song: SongDto | null = null;
  playbackRate = 1;
  pitchShift = 0;
  readonly mixerGains = new Map<string, number>();

  async checkpoint(readSnapshot: () => Promise<PlaybackSnapshot>): Promise<MediaCheckpoint | null> {
    if (!this.song) return null;
    const before = await readSnapshot();
    return { song: this.song, state: before.state, positionSeconds: before.positionSeconds };
  }

  async restore(
    checkpoint: MediaCheckpoint | null,
    dspParameters: ReadonlyMap<string, number>,
    dspEnabled: boolean,
    monitoring: boolean,
    operations: RestoreOperations,
  ): Promise<void> {
    if (!checkpoint) return;
    await operations.ensureSession();
    const artifacts = await operations.resolveArtifacts(checkpoint.song);
    await operations.command("LoadSong", artifacts);
    await operations.waitForReady();
    await operations.command("SetPlaybackRate", { value: this.playbackRate });
    await operations.command("SetTranspose", { semitones: this.pitchShift });
    for (const [target, value] of this.mixerGains) {
      await operations.command("SetGain", { target, value });
    }
    for (const [name, value] of dspParameters) {
      await operations.command("SetDspParameter", { name, value });
    }
    await operations.command("SetDspEnabled", { enabled: dspEnabled });
    await operations.command("SetMonitoring", { enabled: monitoring });
    const sampleRate = await operations.sampleRate();
    await operations.command("Seek", {
      frame: Math.max(0, Math.round(checkpoint.positionSeconds * sampleRate)),
    });
    if (checkpoint.state === "playing") await operations.command("Play");
  }
}
