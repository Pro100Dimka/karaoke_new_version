import type { RoomStateDto } from "../../contracts/models";
import { canControlRoom } from "./roomModel";

export type RoomSongPlayIntent = "play-local" | "select-room" | "wait-for-host";

/** A card Play click must have one authority while a room is active. */
export const roomSongPlayIntent = (room: RoomStateDto | null): RoomSongPlayIntent => {
  if (!room) return "play-local";
  return canControlRoom(room) ? "select-room" : "wait-for-host";
};
