import { lazy, Suspense } from 'react';
import type { useSongPlayback } from '../songs/useSongActions';

const AddSongModal = lazy(() =>
  import('./add-song').then(({ AddSongModal }) => ({ default: AddSongModal })),
);
const RoomModal = lazy(() =>
  import('../../../features/room/RoomModal').then(({ RoomModal }) => ({
    default: RoomModal,
  })),
);
const ProcessingModal = lazy(() =>
  import('./processing').then(({ ProcessingModal }) => ({
    default: ProcessingModal,
  })),
);

type Props = {
  droppedPath: string | null;
  closeAddSong(): void;
  roomOpen: boolean;
  invitationCode?: string;
  closeRoom(): void;
  processing: { focusSongId?: string } | null;
  closeProcessing(): void;
  onPlay: ReturnType<typeof useSongPlayback>['playSong'];
};

/** Independent boundaries keep one modal's loading from hiding another. */
export const LibraryModals = ({
  droppedPath,
  closeAddSong,
  roomOpen,
  invitationCode,
  closeRoom,
  processing,
  closeProcessing,
  onPlay,
}: Props) => (
  <>
    {droppedPath !== null && (
      <Suspense fallback={null}>
        <AddSongModal open initialPath={droppedPath} onClose={closeAddSong} />
      </Suspense>
    )}
    {roomOpen && (
      <Suspense fallback={null}>
        <RoomModal open invitationCode={invitationCode} onClose={closeRoom} />
      </Suspense>
    )}
    <Suspense fallback={null}>
      {processing !== null && (
        <ProcessingModal
          open
          focusSongId={processing.focusSongId}
          onClose={closeProcessing}
          onPlay={onPlay}
        />
      )}
    </Suspense>
  </>
);
