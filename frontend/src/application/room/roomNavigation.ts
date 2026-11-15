import type { RoomStateDto, SongDto } from '../../contracts/models';
import { routes } from '../../shared/routes';
import { localRoomSong } from './roomModel';

type RoomKaraokeNavigation =
  | { kind: 'stay' }
  | { kind: 'open' | 'download'; songId: string; revision: number };

/** Decides how this participant joins an authoritative room playback without route-specific side effects. */
export const roomKaraokeNavigation = (
  room: RoomStateDto,
  pathname: string,
  library: readonly SongDto[],
  importedLocalSongId?: string,
  completedProjectKey?: string,
): RoomKaraokeNavigation => {
  if (!room.songId || room.revision === undefined) {
    return { kind: 'stay' };
  }
  if (completedProjectKey === `${room.songId}:${room.revision}`)
    return { kind: 'stay' };
  const localSong = localRoomSong(room, library, importedLocalSongId);
  if (!localSong) {
    return { kind: 'download', songId: room.songId, revision: room.revision };
  }
  if (pathname === routes.karaoke(localSong.id)) return { kind: 'stay' };
  const projectReadyPhases = new Set<
    RoomStateDto['participants'][number]['readiness']
  >(['preparing', 'audio', 'ready']);
  const everyConnectedParticipantHasProject = room.participants
    .filter((person) => person.connected)
    .every((person) => projectReadyPhases.has(person.readiness));
  if (!everyConnectedParticipantHasProject) return { kind: 'stay' };
  return {
    kind: 'open',
    songId: localSong.id,
    revision: localSong.activeRevision,
  };
};
