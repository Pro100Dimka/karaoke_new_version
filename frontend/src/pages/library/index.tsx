import { runInAction } from "mobx";
import { observer } from "mobx-react-lite";
import { store } from "../../providers/store";
import {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter, Stack, tr, useLocale } from "@neo-ui-kit/react";

import { ru } from "../../i18n/messages.ru";

import { mergeRoomLibrary } from "../../application/room/roomLibrary";
import { RoomModal } from "../../features/room/RoomModal";
import { useKaraokeTv } from "../../features/karaoke/tv/karaokeTv";
import { AddSongModal } from "./modals/add-song/index";
import { loadLastPlayed } from "./songs/lastPlayed";
import "./library.css";
import { LibraryActions, type LibraryFilters } from "./hero/actions";
import { LibraryHeader } from "./hero/index";
import { selectLibrarySongs } from "./songs/librarySelectors";
import { ProcessingModal } from "./modals/processing/index";
import { RecordingsModal } from "./modals/recordings/index";
import { SongSettingsModal } from "./modals/song-settings/index";
import { useLibraryImport } from "./modals/add-song/useLibraryImport";
import { libraryCommands } from "../../app/desktop/shellBus";
import { useLibrarySongs } from "./songs/useLibrarySongs";
import { useRoomLibrary } from "./songs/useRoomLibrary";
import { useSongActions, curtainMilliseconds } from "./songs/useSongActions";
import LibrarySongs from "./songs";


export const LibraryPage = observer(() => {
  useEffect(() => () => runInAction(() => {
    Object.assign(store.libraryDialogs, {
      settingsSong: null, recordingsSong: null, analysisRecordId: null,
      processingOpen: false, focusSongId: undefined, addOpen: false, droppedPath: "",
    });
  }), []);
  const pageRef = useRef<HTMLElement>(null);
  const { navigate } = useRouter();
  const tv = useKaraokeTv();
  const entrance = store.playback.returned;
  const [returning, setReturning] = useState(
    Boolean(entrance?.performanceReturn),
  );
  const titleId = useId();
  useLocale();
  const { preferences } = store;
  const { localProcessing } = store.application;
  const { python } = store.application.services;

  const { query, filters: viewFilters } = store.library;
  const [roomOpen, setRoomOpen] = useState(false);
  const [invitationCode, setInvitationCode] = useState<string>();
  const { processingOpen, focusSongId } = store.libraryDialogs;
  const [selecting, setSelecting] = useState(false);
  const deferredQuery = useDeferredValue(query);
  const roomLibrary = useRoomLibrary({
    setQuery: value => runInAction(() => { store.library.query = value; }),
    setViewFilters: update => runInAction(() => { store.library.filters = update(store.library.filters); }),
  });
  const { room } = roomLibrary;

  const filters: LibraryFilters = useMemo(
    () => ({
      ...viewFilters,
      sort: preferences.librarySort,
      direction: preferences.librarySortDirection,
    }),
    [viewFilters, preferences.librarySort, preferences.librarySortDirection],
  );
  const completeCatalog = !!room || processingOpen || selecting || filters.sort === "played" || !!entrance?.analysisFor;
  const serverFilter = useMemo(() => ({ ...filters, query: deferredQuery }), [filters, deferredQuery]);
  const library = useLibrarySongs(completeCatalog ? undefined : serverFilter);
  const { state } = library;

  const localSongs = useMemo(
    () => (state.status === "ready" ? state.songs : []),
    [state],
  );
  const selfId = room?.participants.find((person) => person.self)?.id ?? "";
  const songs = useMemo(
    () => mergeRoomLibrary(localSongs, room?.sharedSongs ?? [], selfId),
    [localSongs, room?.sharedSongs, selfId],
  );
  const played = useMemo(() => loadLastPlayed(), []);
  const visibleSongs = useMemo(
    () =>
      completeCatalog ? selectLibrarySongs(songs, serverFilter, played) : songs,
    [songs, completeCatalog, serverFilter, played],
  );

  const reveal =
    state.status !== "loading" &&
    (!entrance?.analysisFor ||
      store.libraryDialogs.analysisRecordId === entrance.analysisFor ||
      state.status === "error");
  useEffect(() => {
    if (!returning || !reveal) return;
    const timer = window.setTimeout(
      () => setReturning(false),
      curtainMilliseconds,
    );
    return () => window.clearTimeout(timer);
  }, [returning, reveal]);
  const returnCurtain = returning && (
    <div
      className="sceneCurtain"
      data-phase={reveal ? "opening" : "waiting"}
      aria-hidden
      style={{
        animationDirection: "reverse",
        ...(reveal ? {} : { animation: "none" }),
      }}
    />
  );
  const { playSong, launching } = useSongActions(
    library,
    () => {},
    { songs, roomLibrary, navigate, tv },
  );
  const songImport = useLibraryImport();
  // The desktop's requests (jump list, invitation links, files opened with the app) are taken once
  // the backend can import; until then they wait in the queue.
  const importRef = useRef(songImport);
  importRef.current = songImport;
  const backendReady = python.kind === "ready";
  useEffect(() => {
    if (!backendReady) return;
    return libraryCommands.subscribe((command) => {
      if (command.type === "addSong") void importRef.current.addSong();
      else if (command.type === "importFiles")
        void importRef.current.importFiles(command.paths);
      else {
        setInvitationCode(command.code);
        setRoomOpen(true);
      }
    });
  }, [backendReady]);

  const readyCount = songs.filter((song) => song.status === "ready").length;

  return (
    <Stack as="main" ref={pageRef} style={{ height: "100%", minHeight: 0, overflowX: "hidden", overflowY: "auto" }} {...songImport.dropTarget}>
      {songImport.dragging && (
        <div className="dropOverlay">{tr(ru.dropToImport)}</div>
      )}
      <Stack as="section" gap={4}
        style={{ width: '90%', marginInline: 'auto', paddingBlock: '5vh', flexShrink: 0, position: 'relative', zIndex: 1 }}>
        <LibraryHeader
          titleId={titleId}
          songCount={completeCatalog && !library.stale ? songs.length : library.summary?.total ?? "—"}
          readyCount={completeCatalog && !library.stale ? readyCount : library.summary?.ready ?? "—"}
        />
        <LibraryActions
          roomRole={room?.role}
          collaborativeControl={room?.collaborativeControl}
          onCollaborativeControlChange={roomLibrary.setCollaborativeControl}
          onOpenRoom={() => setRoomOpen(true)}
          onViewChange={roomLibrary.publishView}
        />
        <LibrarySongs pageRef={pageRef} library={library} songs={songs} localSongs={localSongs}
          visibleSongs={visibleSongs} completeCatalog={completeCatalog}
          selecting={selecting} setSelecting={setSelecting}
          onPlay={playSong} songSelection={roomLibrary.songSelection} />
      </Stack>
      <AddSongModal />
      <RoomModal
        open={roomOpen}
        invitationCode={invitationCode}
        onClose={() => {
          setRoomOpen(false);
          setInvitationCode(undefined);
        }}
      />
      <ProcessingModal
        open={processingOpen}
        songs={songs}
        focusSongId={focusSongId}
        onClose={() => runInAction(() => { store.libraryDialogs.processingOpen = false; })}
        onPlay={playSong}
        playbackDisabled={localProcessing}
      />
      <SongSettingsModal />
      <RecordingsModal songs={songs} ready={state.status === "ready"} />
      {launching && <div className="sceneCurtain" aria-hidden />}
      {returnCurtain}
    </Stack>
  );
});

export default LibraryPage;
