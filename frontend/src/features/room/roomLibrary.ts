import type { RoomSongDto, SongDto } from "../../contracts/models";

const asRemoteSong = (song: RoomSongDto): SongDto => ({
  id: song.songId,
  title: song.title,
  artist: song.artist,
  album: song.album,
  genre: song.genre,
  language: "Auto",
  status: "ready",
  durationSeconds: song.durationSeconds,
  createdAt: "1970-01-01T00:00:00.000Z",
  coverState: "Fallback",
  activeRevision: song.revision,
  projectFormatVersion: 1,
  roomOwnerId: song.ownerParticipantId
});

/** Presents one room-wide catalog while retaining exact local projects when available. */
export const mergeRoomLibrary = (
  localSongs: readonly SongDto[],
  sharedSongs: readonly RoomSongDto[],
  selfParticipantId: string
): SongDto[] => {
  const merged = new Map(localSongs.map(song => [song.id, song]));
  for (const shared of sharedSongs) {
    if (shared.ownerParticipantId === selfParticipantId) continue;
    const local = merged.get(shared.songId);
    if (local?.activeRevision === shared.revision && local.status === "ready") continue;
    if (!local || shared.revision > local.activeRevision || local.status !== "ready") {
      merged.set(shared.songId, asRemoteSong(shared));
    }
  }
  return [...merged.values()];
};

export const roomProjectKey = (roomCode: string, song: SongDto): string =>
  `${roomCode}:${song.id}:${song.activeRevision}`;

export const pendingRoomProjects = (
  roomCode: string,
  songs: readonly SongDto[],
  uploaded: ReadonlySet<string>,
  selectedSongId?: string,
  selectedRevision?: number
): SongDto[] => {
  const pending = songs.filter(song => !uploaded.has(roomProjectKey(roomCode, song)));
  if (!selectedSongId || selectedRevision === undefined) return pending;
  return [...pending].sort((left, right) => {
    const leftSelected = left.id === selectedSongId && left.activeRevision === selectedRevision;
    const rightSelected = right.id === selectedSongId && right.activeRevision === selectedRevision;
    return Number(rightSelected) - Number(leftSelected);
  });
};

/** Room archives are produced on demand; publishing metadata must never package the entire library. */
export const selectedRoomProjectUpload = (
  roomCode: string,
  songs: readonly SongDto[],
  uploaded: ReadonlySet<string>,
  selectedSongId?: string,
  selectedRevision?: number
): SongDto | undefined => {
  if (!selectedSongId || selectedRevision === undefined) return undefined;
  return songs.find(song =>
    song.id === selectedSongId &&
    song.activeRevision === selectedRevision &&
    !uploaded.has(roomProjectKey(roomCode, song))
  );
};
