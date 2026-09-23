import type { RoomStateDto, SongDto } from "../../contracts/models";
import { routes } from "../../app/routes";

export type RoomKaraokeNavigation =
  | { kind: "stay" }
  | { kind: "library" }
  | { kind: "open" | "download"; songId: string; revision: number };

/** Decides how this participant joins an authoritative room playback without route-specific side effects. */
export const roomKaraokeNavigation = (
  room: RoomStateDto,
  pathname: string,
  library: readonly SongDto[],
  importedLocalSongId?: string
): RoomKaraokeNavigation => {
  if (!room.songId || room.revision === undefined) {
    return pathname.startsWith("/karaoke/") ? { kind: "library" } : { kind: "stay" };
  }
  const localSongId = importedLocalSongId ?? room.songId;
  if (pathname === routes.karaoke(localSongId)) return { kind: "stay" };
  const local = library.find(song =>
    song.id === localSongId && song.activeRevision === room.revision && song.status === "ready"
  );
  return local
    ? { kind: "open", songId: localSongId, revision: room.revision }
    : { kind: "download", songId: room.songId, revision: room.revision };
};
