import { Stack, tr, useLocale, useRouter } from '@neo-ui-kit/react';
import { observer } from 'mobx-react-lite';
import { useCallback, useRef, useState } from 'react';

import { useKaraokeTv } from '../../features/karaoke/tv/karaokeTv';
import Hero from './hero';
import { useLibraryView } from './hero/filters&actions/useLibraryView';
import { LibraryModals } from './modals/LibraryModals';
import LibrarySongs from './songs';
import { useRoomLibrary } from './songs/useRoomLibrary';
import { useSongPlayback } from './songs/useSongActions';
import { useLibraryDesktop } from './useLibraryDesktop';
import './library.css';

const LibraryPage = observer(() => {
  useLocale();
  const pageRef = useRef<HTMLElement>(null);
  const { navigate } = useRouter();
  const tv = useKaraokeTv();
  const { view, setQuery, setViewFilters } = useLibraryView();
  const roomLibrary = useRoomLibrary({ setQuery, setViewFilters });
  const { playSong, launching } = useSongPlayback({ roomLibrary, navigate, tv });

  const [processing, setProcessing] = useState<{ focusSongId?: string } | null>(null);
  const [roomOpen, setRoomOpen] = useState(false);
  const [invitationCode, setInvitationCode] = useState<string>();

  const openProcessing = useCallback(
    (focusSongId?: string) => setProcessing({ focusSongId }),
    [],
  );
  const closeRoom = useCallback(() => {
    setRoomOpen(false);
    setInvitationCode(undefined);
  }, []);
  const openInvitation = useCallback((code: string) => {
    setInvitationCode(code);
    setRoomOpen(true);
  }, []);
  const desktop = useLibraryDesktop(openInvitation);

  return (
    <Stack
      as="main"
      ref={pageRef}
      style={{ height: '100%', minHeight: 0, overflowX: 'hidden', overflowY: 'auto' }}
      onDragOver={desktop.onDragOver}
      onDragLeave={desktop.onDragLeave}
      onDrop={desktop.onDrop}
    >
      {desktop.dragging && <div className="dropOverlay">{tr('dropToImport')}</div>}

      <Stack
        as="section"
        gap={4}
        style={{
          width: '90%',
          marginInline: 'auto',
          paddingBlock: '5vh',
          flexShrink: 0,
          position: 'relative',
          zIndex: 1,
        }}
      >
        <Hero
          view={view}
          setQuery={setQuery}
          setViewFilters={setViewFilters}
          roomLibrary={roomLibrary}
          openProcessing={openProcessing}
          onOpenRoom={() => setRoomOpen(true)}
        />
        <LibrarySongs
          view={view}
          pageRef={pageRef}
          onPlay={playSong}
          onOpenProcessing={openProcessing}
          songSelection={roomLibrary.songSelection}
        />
      </Stack>

      <LibraryModals
        droppedPath={desktop.droppedPath}
        closeAddSong={desktop.closeAddSong}
        roomOpen={roomOpen}
        invitationCode={invitationCode}
        closeRoom={closeRoom}
        processing={processing}
        closeProcessing={() => setProcessing(null)}
        onPlay={playSong}
      />
      {launching && <div className="sceneCurtain" aria-hidden />}
    </Stack>
  );
});

export default LibraryPage;
