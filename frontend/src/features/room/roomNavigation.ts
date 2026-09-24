import type { RoomStateDto, SongDto } from "../../contracts/models";
import { routes } from "../../app/routes";

export type RoomKaraokeNavigation =
  | { kind: "stay" }
  | { kind: "open" | "download"; songId: string; revision: number };

/** Decides how this participant joins an authoritative room playback without route-specific side effects. */
export const roomKaraokeNavigation = (
  room: RoomStateDto,
  pathname: string,
  library: readonly SongDto[],
  importedLocalSongId?: string,
  completedProjectKey?: string
): RoomKaraokeNavigation => {
  if (!room.songId || room.revision === undefined) {
    return { kind: "stay" };
  }
  if (completedProjectKey === `${room.songId}:${room.revision}`) return { kind: "stay" };
  const localSongId = importedLocalSongId ?? room.songId;
  if (pathname === routes.karaoke(localSongId)) return { kind: "stay" };
  const local = library.find(song =>
    song.id === localSongId && song.activeRevision === room.revision && song.status === "ready"
  );
  if (!local) return { kind: "download", songId: room.songId, revision: room.revision };
  const projectReadyPhases = new Set<RoomStateDto["participants"][number]["readiness"]>([
    "preparing",
    "audio",
    "ready",
  ]);
  const everyConnectedParticipantHasProject = room.participants
    .filter(person => person.connected)
    .every(person => projectReadyPhases.has(person.readiness));
  if (!everyConnectedParticipantHasProject) return { kind: "stay" };
  return { kind: "open", songId: localSongId, revision: room.revision };
};
