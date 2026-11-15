import { lazy, Suspense } from 'react';
import type { useSongPlayback } from '../songs/useSongActions';

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
  roomOpen: boolean;
  invitationCode?: string;
  closeRoom(): void;
  processing: { focusSongId?: string } | null;
  closeProcessing(): void;
  onPlay: ReturnType<typeof useSongPlayback>['playSong'];
};

/** Independent boundaries keep one modal's loading from hiding another. */
export const LibraryModals = ({
  roomOpen,
  invitationCode,
  closeRoom,
  processing,
  closeProcessing,
  onPlay,
}: Props) => (
  <>
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
