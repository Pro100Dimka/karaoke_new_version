import type { RoomStateDto } from "../../contracts/models";
import type { KaraokeState } from "../karaoke/karaokeMachine";
import type { KaraokeAudioPort } from "../karaoke/KaraokePorts";
import { createLatestSnapshotQueue } from "./latestSnapshotQueue";
import { allConnectedReady } from "./roomModel";
import { roomPlaybackSnapshotKey, synchronizeRoomPlayback } from "./roomPlayback";

export interface RoomPlaybackObservation {
  room: RoomStateDto | null;
  ready: boolean;
  stateKind: KaraokeState["kind"];
  onEvent(event: "PLAY" | "PAUSE"): void;
  onFinished(): void;
  onFailure(error: unknown): void;
}

/** Serializes native updates from authoritative server snapshots within one current observation. */
export class RoomPlaybackSynchronizer {
  private current?: RoomPlaybackObservation;
  private key = "";
  private version = 0;
  private scheduledUntil = 0;
  private received = { at: 0, serverNow: NaN };
  private readonly pending = createLatestSnapshotQueue((run: () => Promise<void>) => run());

  constructor(private readonly audio: KaraokeAudioPort) {}

  receive(options: RoomPlaybackObservation): string {
    this.current = options;
    const key = options.room ? roomPlaybackSnapshotKey(options.room) : "";
    if (this.key !== key) {
      this.key = key;
      this.version++;
      this.received = {
        at: performance.now(),
        serverNow: options.room?.serverClockOffsetMilliseconds === undefined
          ? Date.parse(options.room?.serverNow ?? "")
          : performance.now() + options.room.serverClockOffsetMilliseconds,
      };
    }
    return `${key}|${options.ready && (!options.room || allConnectedReady(options.room))}|${options.stateKind === "preparing"}`;
  }

  activate(): () => void {
    const snapshot = this.current?.room;
    const ready = this.current?.ready && (!snapshot || allConnectedReady(snapshot));
    const preparing = this.current?.stateKind === "preparing";
    const version = this.version;
    if (!snapshot || !ready || preparing) {
      this.pending.push(async () => {
        if (version !== this.version || this.scheduledUntil === 0) return;
        this.scheduledUntil = 0;
        try {
          if ((await this.audio.snapshot()).state === "playing")
            await this.audio.pause();
        } catch (error) {
          if (version === this.version) this.current?.onFailure(error);
        }
      });
      return () => undefined;
    }

    const anchor = this.received;
    let timer: number | undefined;
    let active = true;
    const isCurrent = () => active && version === this.version;
    const emit = (event: "PLAY" | "PAUSE" | "FINISH") => {
      if (!isCurrent()) return;
      if (event === "FINISH") this.current?.onFinished();
      else this.current?.onEvent(event);
    };
    const apply = () => this.pending.push(async () => {
      try {
        if (!isCurrent()) return;
        const native = await this.audio.snapshot();
        if (!isCurrent()) return;
        const timedSnapshot = Number.isFinite(anchor.serverNow)
          ? { ...snapshot,
              serverNow: new Date(anchor.serverNow + performance.now() - anchor.at).toISOString(),
              serverClockOffsetMilliseconds: undefined }
          : snapshot;
        const delay = await synchronizeRoomPlayback(
          timedSnapshot, this.current!.stateKind, native.positionSeconds,
          this.audio, emit, isCurrent, native.state,
        );
        if (version !== this.version) return;
        this.scheduledUntil = delay === undefined ? 0 : performance.now() + delay;
        if (isCurrent() && delay !== undefined)
          timer = window.setTimeout(() => void apply(), delay);
      } catch (error) {
        if (isCurrent()) this.current?.onFailure(error);
      }
    });
    void apply();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }
}
