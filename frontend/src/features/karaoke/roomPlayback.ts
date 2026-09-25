import type { RoomCommand } from "../../contracts/clients";
import type { RoomStateDto } from "../../contracts/models";
import type { KaraokeEvent, KaraokeState } from "./karaokeMachine";
import { playbackPlan } from "../room/roomModel";
import type { KaraokeOpenMode } from "./useKaraokeSession";

export const roomPlaybackSnapshotKey = (room: RoomStateDto): string => [
  room.code,
  room.songId,
  room.revision,
  room.playbackState,
  room.playbackStartedAt,
  room.playbackPositionSeconds,
  room.playbackRate,
  room.serverNow,
  room.serverClockOffsetMilliseconds,
  room.participants.map(participant => `${participant.id}=${participant.voiceLatencyMs ?? 0}`).join(","),
].join(":");

export const roomSelectionEnded = (
  mode: KaraokeOpenMode,
  roomSongId: string | undefined,
  local: KaraokeState["kind"]
): boolean => mode === "RoomPrepared"
  && roomSongId === undefined
  && (local === "ready" || local === "playing" || local === "paused");

export const roomToggleCommand = (room: RoomStateDto): RoomCommand | null => {
  if (room.role !== "host" && !room.collaborativeControl) return null;
  return room.playbackState === "playing" ? "Pause" : "Start";
};

export const roomPlaybackEvent = (
  playback: RoomStateDto["playbackState"],
  local: KaraokeState["kind"]
): Extract<KaraokeEvent, { type: "PLAY" | "PAUSE" | "FINISH" }>["type"] | null => {
  if (playback === "playing" && (local === "ready" || local === "paused")) return "PLAY";
  if (playback === "paused" && local === "playing") return "PAUSE";
  if (playback === "stopped" && (local === "playing" || local === "paused")) return "FINISH";
  return null;
};

interface RoomPlaybackAudio {
  seek(seconds: number): Promise<unknown>;
  play(schedule?: { startAtMilliseconds: number; positionSeconds: number }): Promise<unknown>;
  pause(): Promise<unknown>;
}

// Forty to eighty milliseconds already sounds like a second voice/beat. Keep only
// sub-frame clock noise uncorrected and converge room media before it is audible.
const maximumUncorrectedDriftSeconds = 0.02;

/** Applies one authoritative room snapshot to the local audio engine. Future starts return their countdown delay. */
export const synchronizeRoomPlayback = async (
  room: RoomStateDto,
  local: KaraokeState["kind"],
  localPosition: number,
  audio: RoomPlaybackAudio,
  onEvent: (event: "PLAY" | "PAUSE" | "FINISH") => void,
  isCurrent: () => boolean = () => true,
  nativeState: KaraokeState["kind"] = local,
): Promise<number | undefined> => {
  if (!isCurrent()) return undefined;
  const plan = playbackPlan(room);
  if (plan.kind === "schedule") {
    const startAtMilliseconds = performance.now() + plan.delayMilliseconds;
    await audio.play({ startAtMilliseconds, positionSeconds: plan.positionSeconds });
    return Math.max(0, startAtMilliseconds - performance.now());
  }
  if (plan.kind === "stop" || (nativeState === "finished" && local === "playing")) {
    if (local === "playing" || local === "paused") onEvent("FINISH");
    return undefined;
  }
  if (plan.kind === "pause") {
    if (nativeState === "playing") await audio.pause();
    if (!isCurrent()) return undefined;
    if (nativeState === "playing" || Math.abs(localPosition - plan.positionSeconds) > 0.0001)
      await audio.seek(plan.positionSeconds);
    if (isCurrent() && local === "playing") onEvent("PAUSE");
    return undefined;
  }
  if (nativeState !== "playing" || Math.abs(localPosition - plan.positionSeconds) > maximumUncorrectedDriftSeconds) {
    // Decoder preparation and IPC finish before this deadline. AudioService compensates a late
    // command against the same target and continuously follows its clock after the start.
    const leadMilliseconds = 100;
    const startAtMilliseconds = performance.now() + leadMilliseconds;
    await audio.play({ startAtMilliseconds,
      positionSeconds: plan.positionSeconds + leadMilliseconds / 1000 * (room.playbackRate ?? 1) });
    return Math.max(0, startAtMilliseconds - performance.now());
  }
  if (isCurrent() && local !== "playing") onEvent("PLAY");
  return undefined;
};
