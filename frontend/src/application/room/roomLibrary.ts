import type { RoomSongDto, SongDto } from '../../contracts/models';

/** Catalog identity is separate from the exact processed project required for playback. */
export const sameRoomSong = (
  first: Pick<SongDto, 'sourceHash' | 'projectHash'>,
  second: Pick<SongDto, 'sourceHash' | 'projectHash'>,
): boolean =>
  Boolean(
    (first.sourceHash && first.sourceHash === second.sourceHash) ||
    (first.projectHash && first.projectHash === second.projectHash),
  );

const asRemoteSong = (song: RoomSongDto): SongDto => ({
  id: song.songId,
  title: song.title,
  artist: song.artist,
  album: song.album,
  genre: song.genre,
  language: 'Auto',
  status: 'ready',
  durationSeconds: song.durationSeconds,
  createdAt: '1970-01-01T00:00:00.000Z',
  coverState: 'Fallback',
  activeRevision: song.revision,
  sourceHash: song.sourceHash,
  projectHash: song.projectHash,
  projectFormatVersion: 1,
  roomOwnerId: song.ownerParticipantId,
});

/** Presents one room-wide catalog while retaining exact local projects when available. */
export const mergeRoomLibrary = (
  localSongs: readonly SongDto[],
  sharedSongs: readonly RoomSongDto[],
  selfParticipantId: string,
): SongDto[] => {
  const merged = new Map(localSongs.map((song) => [song.id, song]));
  for (const shared of sharedSongs) {
    if (shared.ownerParticipantId === selfParticipantId) continue;
    const local =
      merged.get(shared.songId) ??
      [...merged.values()].find((song) => sameRoomSong(song, shared));
    const sameProject = shared.projectHash
      ? local?.projectHash === shared.projectHash
      : local?.activeRevision === shared.revision;
    if (
      local?.status === 'ready' &&
      (sameProject || local.id !== shared.songId)
    )
      continue;
    if (
      !local ||
      !sameProject ||
      shared.revision > local.activeRevision ||
      local.status !== 'ready'
    ) {
      if (local) merged.delete(local.id);
      merged.set(shared.songId, asRemoteSong(shared));
    }
  }
  return [...merged.values()];
};

export const roomProjectKey = (roomCode: string, song: SongDto): string =>
  `${roomCode}:${song.id}:${song.activeRevision}${song.projectHash ? `:${song.projectHash}` : ''}`;
/** Room archives are produced on demand; publishing metadata must never package the entire library. */
export const selectedRoomProjectUpload = (
  roomCode: string,
  songs: readonly SongDto[],
  uploaded: ReadonlySet<string>,
  selectedSongId?: string,
  selectedRevision?: number,
  selectedOwnerParticipantId?: string,
  selfParticipantId?: string,
): SongDto | undefined => {
  if (!selectedSongId || selectedRevision === undefined) return undefined;
  if (
    selectedOwnerParticipantId &&
    selectedOwnerParticipantId !== selfParticipantId
  )
    return undefined;
  return songs.find(
    (song) =>
      song.id === selectedSongId &&
      song.activeRevision === selectedRevision &&
      !uploaded.has(roomProjectKey(roomCode, song)),
  );
};
