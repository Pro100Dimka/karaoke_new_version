import { useEffect } from 'react';
import type {
  KaraokeOpenMode,
  KaraokeState,
} from '../../application/karaoke/karaokeMachine';
import type { RoomStateDto } from '../../contracts/models';
import type { useRoomPlayback } from '../../providers/application';
export const usePreparedRoomAudio = (
  room: RoomStateDto | null,
  mode: KaraokeOpenMode,
  loadKind: string,
  stateKind: KaraokeState['kind'],
  playback: ReturnType<typeof useRoomPlayback>,
  onFailure: (error: unknown) => void,
): void => {
  const selfReadiness = room?.participants.find(
    (person) => person.self,
  )?.readiness;
  useEffect(() => {
    if (
      !room ||
      mode !== 'RoomPrepared' ||
      loadKind !== 'ready' ||
      stateKind !== 'ready' ||
      !playback ||
      !room.songId ||
      room.revision === undefined
    )
      return;
    void playback.reportReady(room.songId, room.revision).catch(onFailure);
  }, [
    room?.code,
    room?.songId,
    room?.revision,
    room?.selectionId,
    selfReadiness,
    mode,
    loadKind,
    stateKind,
    playback,
    onFailure,
  ]);
};
