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
  room.serverNow,
  room.serverClockOffsetMilliseconds
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
  play(): Promise<unknown>;
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
): Promise<number | undefined> => {
  const plan = playbackPlan(room);
  if (plan.kind === "schedule") return plan.delayMilliseconds;
  if (plan.kind === "stop") {
    if (local === "playing" || local === "paused") onEvent("FINISH");
    return undefined;
  }
  if (Math.abs(localPosition - plan.positionSeconds) > maximumUncorrectedDriftSeconds || local === "ready") {
    await audio.seek(plan.positionSeconds);
  }
  if (plan.kind === "pause") {
    if (local === "playing") await audio.pause();
    if (local === "playing") onEvent("PAUSE");
    return undefined;
  }
  if (local !== "playing") await audio.play();
  if (local !== "playing") onEvent("PLAY");
  return undefined;
};
