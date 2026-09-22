import type { RoomStateDto, SongDto } from "../../contracts/models";
import { routes } from "../../app/routes";

export type RoomKaraokeNavigation =
  | { kind: "stay" }
  | { kind: "open" | "download"; songId: string; revision: number };

/** Decides how this participant joins an authoritative room playback without route-specific side effects. */
export const roomKaraokeNavigation = (
  room: RoomStateDto,
  pathname: string,
  library: readonly SongDto[]
): RoomKaraokeNavigation => {
  if (!room.songId || room.revision === undefined) return { kind: "stay" };
  if (pathname === routes.karaoke(room.songId)) return { kind: "stay" };
  const local = library.find(song =>
    song.id === room.songId && song.activeRevision === room.revision && song.status === "ready"
  );
  return { kind: local ? "open" : "download", songId: room.songId, revision: room.revision };
};
