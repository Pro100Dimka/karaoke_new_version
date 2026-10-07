import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "../../app/AppContext";
import { useNotify } from "../../app/NotificationsProvider";
import { routes } from "../../shared/routes";
import { useServices } from "../../app/ServicesContext";
import type { SongPatch } from "../../contracts/clients";
import type { SongDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { desktopClient } from "../../services/desktopClient";
import { useDebouncedValue } from "../../shared/hooks/useDebouncedValue";
import { Button, Card, EmptyState, Shimmer } from "@ad-voice/ui";
import { mergeRoomLibrary } from "../../application/room/roomLibrary";
import { RoomModal } from "../room/RoomModal";
import { roomSongPlayIntent } from "../room/roomSongIntent";
import { AddSongModal } from "./AddSongModal";
import { loadLastPlayed, markPlayed } from "./lastPlayed";
import "./library.css";
import { LibraryActions, type LibraryFilters } from "./LibraryActions";
import { LibraryEmptyState } from "./LibraryEmptyState";
import { LibraryHeader } from "./LibraryHeader";
import { selectLibrarySongs } from "./librarySelectors";
import { libraryViewState } from "./libraryViewState";
import { PerformanceAnalysisModal } from "./PerformanceAnalysisModal";
import { ProcessingModal } from "./ProcessingModal";
import { RecordingsModal } from "./RecordingsModal";
import { SongCard, type SongCardHandlers } from "./SongCard";
import { SongSettingsModal } from "./SongSettingsModal";
import { useGuardedAction } from "./useGuardedAction";
import { useLibraryImport } from "./useLibraryImport";
import { useLibrarySongs } from "./useLibrarySongs";
import { useRoomLibrary } from "./useRoomLibrary";
import { useSongActions } from "./useSongActions";
import { useSongRecordings } from "./useSongRecordings";
import { VirtualGrid } from "./VirtualGrid";

/** Placeholder cards shown in the grid's place while the songs load. */
const skeletonCards = ["one", "two", "three", "four", "five", "six", "seven", "eight"] as const;
const activeJobStatuses = new Set<SongDto["status"]>(["queued", "processing"]);

const searchDebounceMilliseconds = 150;
/** The curtain closes over the library before the karaoke scene opens. */
const curtainMilliseconds = 400;
const cardHeight = 187;
const cardAspectRatio = 1.62;

const LibraryLoading = ({ pageRef }: { pageRef: RefObject<HTMLElement | null> }) => {
  const t = useText();
  return (
    <main className="libraryPage" ref={pageRef}>
      <div className="librarySkeleton" aria-live="polite" aria-busy="true" aria-label={t("loadingLibrary")}>
        {skeletonCards.map((id) => (
          <Card key={id} border padding="md">
            <Shimmer lines={3} circle />
          </Card>
        ))}
      </div>
    </main>
  );
};

const LibraryLoadError = ({ pageRef, onRetry }: { pageRef: RefObject<HTMLElement | null>; onRetry: () => void }) => {
  const t = useText();
  const errorTitleId = useId();
  return (
    <main className="libraryPage" ref={pageRef}>
      <section className="libraryState" id={errorTitleId} aria-label={t("libraryLoadFailed")}>
        <EmptyState
          icon="warning"
          title={t("libraryLoadFailed")}
          action={
            <Button variant="primary" icon="refresh" onClick={onRetry}>
              {t("retry")}
            </Button>
          }
        />
      </section>
    </main>
  );
};

/** Keeps the scroll position across visits: restored once the list exists, remembered on leaving. */
const useRememberedScroll = (pageRef: RefObject<HTMLElement | null>, listReady: boolean) => {
  const restored = useRef(false);
  useEffect(() => {
    const page = pageRef.current;
    if (!page || !listReady || restored.current) return;
    restored.current = true;
    page.scrollTop = libraryViewState.scrollTop;
  }, [pageRef, listReady]);
  useEffect(() => {
    const page = pageRef.current;
    return () => {
      if (page) libraryViewState.scrollTop = page.scrollTop;
    };
  }, [pageRef]);
};

/** Card handlers that keep their identity across renders (the virtual grid keeps cards mounted)
 * while always calling the page's latest handlers. */
const useStableCardHandlers = (handlers: SongCardHandlers): SongCardHandlers => {
  const latest = useRef(handlers);
  useLayoutEffect(() => {
    latest.current = handlers;
  });
  return useMemo<SongCardHandlers>(
    () => ({
      onPlay: (song) => latest.current.onPlay(song),
      onProcess: (song) => latest.current.onProcess(song),
      onCancel: (song) => latest.current.onCancel(song),
      onDetails: (song) => latest.current.onDetails(song),
      onSettings: (song) => latest.current.onSettings(song),
      onRecordings: (song) => latest.current.onRecordings(song),
      onOpenFolder: (song) => latest.current.onOpenFolder(song),
      onDelete: (song) => latest.current.onDelete(song),
      onViewError: (song) => latest.current.onViewError(song),
    }),
    [],
  );
};

export const LibraryPage = () => {
  const navigate = useNavigate();
  const t = useText();
  const notify = useNotify();
  const guarded = useGuardedAction();
  const titleId = useId();
  const pageRef = useRef<HTMLElement>(null);
  const { preferences, updatePreferences, openSettings } = useApp();
  const { python } = useServices();
  const library = useLibrarySongs();
  const { state } = library;

  const [query, setQuery] = useState(libraryViewState.query);
  const [viewFilters, setViewFilters] = useState(libraryViewState.filters);
  const [roomOpen, setRoomOpen] = useState(false);
  const [processingOpen, setProcessingOpen] = useState(false);
  const [focusSongId, setFocusSongId] = useState<string | undefined>();
  const [settingsSong, setSettingsSong] = useState<SongDto | null>(null);
  const [launching, setLaunching] = useState(false);
  const debouncedQuery = useDebouncedValue(query, searchDebounceMilliseconds);
  const roomLibrary = useRoomLibrary({ setQuery, setViewFilters });
  const { room } = roomLibrary;

  useEffect(() => {
    libraryViewState.query = query;
    libraryViewState.filters = viewFilters;
  }, [query, viewFilters]);
  useRememberedScroll(pageRef, state.status === "ready");

  const localSongs = useMemo(() => (state.status === "ready" ? state.songs : []), [state]);
  const selfId = room?.participants.find((person) => person.self)?.id ?? "";
  const songs = useMemo(
    () => mergeRoomLibrary(localSongs, room?.sharedSongs ?? [], selfId),
    [localSongs, room?.sharedSongs, selfId],
  );
  const played = useMemo(() => loadLastPlayed(), []);
  const filters: LibraryFilters = useMemo(
    () => ({
      ...viewFilters,
      sort: preferences.librarySort,
      direction: preferences.librarySortDirection,
    }),
    [viewFilters, preferences.librarySort, preferences.librarySortDirection],
  );
  const visibleSongs = useMemo(
    () => selectLibrarySongs(songs, { query: debouncedQuery, ...filters }, played),
    [songs, debouncedQuery, filters, played],
  );

  const songRecordings = useSongRecordings(songs, state.status === "ready", library.refresh);
  const { startProcessing, confirmDelete, showError } = useSongActions(library, () =>
    setSettingsSong(null),
  );
  const songImport = useLibraryImport({
    importSong: library.importSong,
    startProcessing,
    guarded,
    backendReady: python.kind === "ready",
  });

  const playSong = (song: SongDto) => {
    const intent = roomSongPlayIntent(room);
    if (intent === "select-room") {
      void roomLibrary.selectSong(song);
      return;
    }
    if (intent === "wait-for-host") {
      notify(t("errorRoomPermission"), "warning");
      return;
    }
    markPlayed(song.id);
    setLaunching(true);
    window.setTimeout(
      () => navigate(routes.karaoke(song.id), { state: { mode: "AutoStart" } }),
      curtainMilliseconds,
    );
  };
  const openFolder = (song: SongDto) => void desktopClient.revealProject(song.id, song.activeRevision);
  const openProcessing = (songId?: string) => {
    setFocusSongId(songId);
    setProcessingOpen(true);
  };

  const cardHandlers = useStableCardHandlers({
    onPlay: playSong,
    onProcess: (song) => void startProcessing(song),
    onCancel: (song) => {
      const { jobId } = song;
      if (jobId) void guarded(() => library.cancelJob(jobId));
    },
    onDetails: (song) => openProcessing(song.id),
    onSettings: setSettingsSong,
    onRecordings: (song) => void songRecordings.open(song),
    onOpenFolder: openFolder,
    onDelete: (song) => void confirmDelete(song),
    onViewError: (song) => void showError(song),
  });

  const handleSaveSong = (song: SongDto, patch: SongPatch) =>
    guarded(async () => {
      await library.updateSong(song, patch);
      setSettingsSong(null);
    });

  const changeQuery = (value: string) => {
    if (!roomLibrary.canChangeView) return;
    setQuery(value);
    roomLibrary.publishView(value, filters);
  };

  const applyFilters = (nextFilters: LibraryFilters) => {
    if (!roomLibrary.canChangeView) return;
    const { sort, direction, ...next } = nextFilters;
    setViewFilters(next);
    updatePreferences({ librarySort: sort, librarySortDirection: direction });
    roomLibrary.publishView(query, nextFilters);
  };

  if (state.status === "loading") return <LibraryLoading pageRef={pageRef} />;
  if (state.status === "error")
    return <LibraryLoadError pageRef={pageRef} onRetry={() => void library.reload()} />;

  const activeJobs = localSongs.filter((song) => activeJobStatuses.has(song.status)).length;
  const readyCount = songs.filter((song) => song.status === "ready").length;
  const addSong = () => void songImport.addSong();

  return (
    <main className="libraryPage" ref={pageRef} {...songImport.dropTarget}>
      {songImport.dragging && <div className="dropOverlay">{t("dropToImport")}</div>}
      <section className="libraryContent" aria-labelledby={titleId}>
        <LibraryHeader titleId={titleId} songCount={songs.length} readyCount={readyCount} />
        <LibraryActions
          query={query}
          filters={filters}
          activeJobs={activeJobs}
          roomRole={room?.role}
          collaborativeControl={room?.collaborativeControl}
          onCollaborativeControlChange={roomLibrary.setCollaborativeControl}
          onQueryChange={changeQuery}
          onFiltersApply={applyFilters}
          onOpenRoom={() => setRoomOpen(true)}
          onOpenProcessing={() => openProcessing()}
          onAddSong={addSong}
        />
        {visibleSongs.length > 0 ? (
          <VirtualGrid
            items={visibleSongs}
            itemKey={(song) => song.id}
            itemHeight={cardHeight}
            itemAspectRatio={cardAspectRatio}
            minColumnWidth={255}
            gap={16}
            scrollParent={pageRef}
            label={t("library")}
            renderItem={(song) => (
              <SongCard
                song={song}
                handlers={cardHandlers}
                roomSelection={roomLibrary.songSelection(song)}
              />
            )}
          />
        ) : (
          <LibraryEmptyState
            kind={songs.length === 0 ? "firstRun" : "noResults"}
            onAddSong={addSong}
            onOpenAudioSettings={() => openSettings("audio")}
            onOpenModels={() => openSettings("ai")}
          />
        )}
      </section>
      <AddSongModal {...songImport.addDialog} onImport={songImport.handleImport} />
      <RoomModal open={roomOpen} onClose={() => setRoomOpen(false)} />
      <ProcessingModal
        open={processingOpen}
        songs={songs}
        focusSongId={focusSongId}
        onClose={() => setProcessingOpen(false)}
        onCancel={(jobId) => guarded(() => library.cancelJob(jobId))}
        onRetry={(song) => startProcessing(song)}
        onOpenFolder={openFolder}
        onPlay={playSong}
      />
      <SongSettingsModal
        song={settingsSong}
        onClose={() => setSettingsSong(null)}
        onSave={handleSaveSong}
        onRemoveCover={async (song) => setSettingsSong(await library.removeSongCover(song))}
        onOpenFolder={openFolder}
        onReprocess={(song) => {
          setSettingsSong(null);
          void startProcessing(song);
        }}
        onDelete={(song) => void confirmDelete(song)}
      />
      <RecordingsModal
        song={songRecordings.song}
        recordings={songRecordings.recordings}
        onClose={songRecordings.close}
        onAnalyze={(recording) => void songRecordings.analyze(recording)}
        onRename={(recording, name) => void songRecordings.rename(recording, name)}
        onDelete={(recording) => void songRecordings.remove(recording)}
      />
      <PerformanceAnalysisModal
        analysis={songRecordings.analysis}
        recordings={songRecordings.recordings}
        onDelete={(recording) => void songRecordings.remove(recording)}
        onCreateStudioMaster={(recording) => void songRecordings.createStudioMaster(recording)}
        studioMaster={songRecordings.studioMaster}
        onClose={songRecordings.closeAnalysis}
      />
      {launching && <div className="sceneCurtain" aria-hidden />}
    </main>
  );
};
