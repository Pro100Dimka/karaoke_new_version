import {
  Stack,
  subscribeTick,
  tr,
  useLocale,
  useMotion,
  useRouter,
} from '@neo-ui-kit/react';
import { observer } from 'mobx-react-lite';
import { startTransition, useCallback, useEffect, useRef, useState } from 'react';

import { store } from '../../providers/store';
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
  const motion = useMotion();
  const qualitySelected = store.preferences.animationQualitySelected;
  const pageRef = useRef<HTMLElement>(null);
  const { navigate } = useRouter();
  const tv = useKaraokeTv();
  const { view, setQuery, setViewFilters } = useLibraryView();
  const roomLibrary = useRoomLibrary({ setQuery, setViewFilters });
  const { playSong, launching } = useSongPlayback({ roomLibrary, navigate, tv });
  const [revealing, setRevealing] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const reveal = useCallback(() => setRevealing(true), []);
  useEffect(() => {
    // A stalled request must not hide the loading or recovery controls indefinitely.
    const timer = window.setTimeout(reveal, 5000);
    return () => window.clearTimeout(timer);
  }, [reveal]);

  useEffect(() => {
    if (!revealed || !motion || qualitySelected) return;
    let started = 0;
    let previous = 0;
    let frames = 0;
    let slowFrames = 0;
    let slowWindows = 0;
    const stop = subscribeTick((now: number) => {
      if (
        document.hidden ||
        !document.hasFocus() ||
        document.querySelector('dialog[open]')
      ) {
        started = previous = frames = slowFrames = slowWindows = 0;
        return;
      }
      started ||= now;
      if (now - started < 1500) {
        previous = now;
        return;
      }
      if (previous && now - previous > 25) slowFrames++;
      previous = now;
      if (++frames < 120) return;
      const light = slowFrames > 12;
      if (light && ++slowWindows < 2) {
        frames = slowFrames = 0;
        return;
      }
      if (!store.preferences.animationQualitySelected)
        store.updatePreferences({
          reducedMotion: light,
          animationQualitySelected: true,
        });
      stop();
    });
    return stop;
  }, [revealed, motion, qualitySelected]);

  const [processing, setProcessing] = useState<{ focusSongId?: string } | null>(null);
  const [roomOpen, setRoomOpen] = useState(false);
  const [invitationCode, setInvitationCode] = useState<string>();

  const openProcessing = useCallback(
    (focusSongId?: string) =>
      startTransition(() => setProcessing({ focusSongId })),
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
          onReady={reveal}
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
      {!revealed && (
        <div
          className="libraryCurtain"
          data-ready={revealing ? '' : undefined}
          aria-hidden
          onAnimationEnd={() => setRevealed(true)}
        />
      )}
    </Stack>
  );
});

export default LibraryPage;
