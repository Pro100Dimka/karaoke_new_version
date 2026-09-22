import type { RoomCommand } from "../../contracts/clients";
import type { RoomStateDto } from "../../contracts/models";
import type { KaraokeEvent, KaraokeState } from "./karaokeMachine";

export const roomToggleCommand = (room: RoomStateDto): RoomCommand | null => {
  if (room.role !== "host") return null;
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
