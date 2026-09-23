import type { ImportMetadata } from "../../contracts/clients";
import { Spinner } from "../../shared/ui/Spinner";
import { Button } from "../../theme/ui";
import { useEffect, useId, useMemo, useRef, useState, type DragEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "../../app/AppContext";
import { useNotify } from "../../app/NotificationsProvider";
import { routes } from "../../app/routes";
import { useServices } from "../../app/ServicesContext";
import type { SongDto } from "../../contracts/models";
import type { SongPatch } from "../../contracts/clients";
import { useText } from "../../i18n/useText";
import { desktopClient } from "../../services/desktopClient";
import { roomClient } from "../../services/roomClient";
import { participantId } from "../../services/roomMappers";
import { errorMessageKey, toAppError } from "../../shared/errors";
import { useDebouncedValue } from "../../shared/hooks/useDebouncedValue";
import { RoomModal } from "../room/RoomModal";
import { sharedLibraryView } from "../room/roomModel";
import { mergeRoomLibrary } from "../room/roomLibrary";
import { roomSongPlayIntent } from "../room/roomSongIntent";
import { AddSongModal } from "./AddSongModal";
import { LibraryEmptyState } from "./LibraryEmptyState";
import { LibraryActions } from "./LibraryActions";
import { LibraryHeader } from "./LibraryHeader";
import { PerformanceAnalysisModal } from "./PerformanceAnalysisModal";
import { ProcessingModal } from "./ProcessingModal";
import { RecordingsModal } from "./RecordingsModal";
import { SongCard, type SongCardHandlers } from "./SongCard";
import { SongSettingsModal } from "./SongSettingsModal";
import { VirtualGrid } from "./VirtualGrid";
import "./library.css";
import { loadLastPlayed, markPlayed } from "./lastPlayed";
import { selectLibrarySongs } from "./librarySelectors";
import { libraryViewState } from "./libraryViewState";
import { useGuardedAction } from "./useGuardedAction";
import { useLibrarySongs } from "./useLibrarySongs";
import { useSongActions } from "./useSongActions";
import { useSongRecordings } from "./useSongRecordings";

const searchDebounceMilliseconds = 150;
const curtainMilliseconds = 400;
const cardHeight = 322;

export const LibraryPage = () => {
  const navigate = useNavigate();
  const t = useText();
  const notify = useNotify();
  const guarded = useGuardedAction();
  const titleId = useId();
  const errorTitleId = useId();
  const pageRef = useRef<HTMLElement>(null);
  const { preferences, updatePreferences, openSettings, room, setRoom } = useApp();
  const { python } = useServices();
  const { state, reload, refresh, importSong, processSong, cancelJob, updateSong, deleteSong } = useLibrarySongs();

  const [query, setQuery] = useState(libraryViewState.query);
  const [status, setStatus] = useState(libraryViewState.status);
  const [addOpen, setAddOpen] = useState(false);
  const [droppedPath, setDroppedPath] = useState("");
  const [dragging, setDragging] = useState(false);
  const [roomOpen, setRoomOpen] = useState(false);
  const [processingOpen, setProcessingOpen] = useState(false);
  const [focusSongId, setFocusSongId] = useState<string | undefined>();
  const [settingsSong, setSettingsSong] = useState<SongDto | null>(null);
  const debouncedQuery = useDebouncedValue(query, searchDebounceMilliseconds);
  const backendReady = python.kind === "ready";

  useEffect(() => {
    libraryViewState.query = query;
    libraryViewState.status = status;
  }, [query, status]);

  useEffect(() => {
    if (!room) return;
    const shared = sharedLibraryView(room);
    setQuery(current => current === shared.query ? current : shared.query);
    setStatus(current => current === shared.status ? current : shared.status);
    if (preferences.librarySort !== shared.sort) updatePreferences({ librarySort: shared.sort });
  }, [room?.libraryQuery, room?.libraryStatus, room?.librarySort, room, preferences.librarySort, updatePreferences]);

  const publishSharedView = (nextQuery: string, nextStatus: typeof status, nextSort: typeof preferences.librarySort) => {
    if (!room) return;
    void roomClient.updateSharedState(room.code, {
      radioEnabled: room.radioEnabled ?? false,
      radioStationId: room.radioStationId ?? preferences.radioStation,
      libraryQuery: nextQuery,
      libraryStatus: nextStatus,
      librarySort: nextSort,
      playbackRate: room.playbackRate ?? 1,
      keyShift: room.keyShift ?? 0
    }).then(setRoom).catch(() => undefined);
  };

  const localSongs = useMemo(() => (state.status === "ready" ? state.songs : []), [state]);
  const songs = useMemo(
    () => mergeRoomLibrary(localSongs, room?.sharedSongs ?? [], participantId),
    [localSongs, room?.sharedSongs]
  );
  const played = useMemo(() => loadLastPlayed(), []);
  const visibleSongs = useMemo(
    () => selectLibrarySongs(songs, { query: debouncedQuery, status, sort: preferences.librarySort }, played),
    [songs, debouncedQuery, status, preferences.librarySort, played]
  );

  // Restore the scroll position once the list exists, and remember it when leaving.
  const restored = useRef(false);
  useEffect(() => {
    const page = pageRef.current;
    if (!page || state.status !== "ready" || restored.current) return;
    restored.current = true;
    page.scrollTop = libraryViewState.scrollTop;
  }, [state.status]);
  useEffect(() => {
    const page = pageRef.current;
    return () => {
      if (page) libraryViewState.scrollTop = page.scrollTop;
    };
  }, []);

  const [launching, setLaunching] = useState(false);
  const songRecordings = useSongRecordings(songs, state.status === "ready", refresh);
  const { startProcessing, confirmDelete, showError } = useSongActions({ processSong, deleteSong }, () =>
    setSettingsSong(null)
  );

  async function selectRoomSong(song: SongDto): Promise<void> {
    if (!room || room.role !== "host") return;
    try {
      setRoom(await roomClient.selectRoomSong(room.code, song.id, song.activeRevision));
    } catch (error) {
      notify(t(errorMessageKey(toAppError(error)) ?? "roomNetworkUnavailable"), "error");
    }
  }

  const handlers: SongCardHandlers = {
    onPlay: song => {
      const intent = roomSongPlayIntent(room);
      if (intent === "select-room") {
        void selectRoomSong(song);
        return;
      }
      if (intent === "wait-for-host") {
        notify(t("errorRoomPermission"), "warning");
        return;
      }
      markPlayed(song.id);
      setLaunching(true);
      window.setTimeout(() => navigate(routes.karaoke(song.id), { state: { mode: "AutoStart" } }), curtainMilliseconds);
    },
    onProcess: song => void startProcessing(song),
    onCancel: song => song.jobId && void guarded(() => cancelJob(song.jobId as string)),
    onDetails: song => {
      setFocusSongId(song.id);
      setProcessingOpen(true);
    },
    onSettings: setSettingsSong,
    onRecordings: song => void songRecordings.open(song),
    onOpenFolder: song => void desktopClient.revealProject(song.id, song.activeRevision),
    onDelete: song => void confirmDelete(song),
    onViewError: song => void showError(song)
  };

  const handleSaveSong = async (song: SongDto, patch: SongPatch) => {
    await guarded(async () => {
      await updateSong(song, patch);
      setSettingsSong(null);
    });
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (!file || !backendReady) return;
    setDroppedPath(desktopClient.pathForFile(file));
    setAddOpen(true);
  };

  const handleImport = async (path: string, metadata: ImportMetadata) => {
    const song = await importSong(path, metadata);
    notify(t("songImported"), "success");
    // A freshly added song is processed right away; a failure to start is reported by the action itself.
    void startProcessing(song);
  };

  // The system file dialog already restricts the choice to supported audio extensions, so there is
  // nothing left for a confirmation step to add; picking a file imports it immediately.
  const addSong = () =>
    guarded(async () => {
      const path = await desktopClient.pickAudioFile();
      if (!path) return;
      try {
        await handleImport(path, {});
      } catch (error) {
        notify(t(errorMessageKey(toAppError(error)) ?? "importFailed"), "error");
      }
    });

  const activeJobs = localSongs.filter(song => song.status === "queued" || song.status === "processing").length;

  if (state.status === "loading") {
    return (
      <main className="libraryPage" ref={pageRef}>
        <div className="libraryState" aria-live="polite">
          <Spinner label={t("loadingLibrary")} />
        </div>
      </main>
    );
  }

  if (state.status === "error") {
    return (
      <main className="libraryPage" ref={pageRef}>
        <section className="libraryState" aria-labelledby={errorTitleId}>
          <h1 id={errorTitleId}>{t("libraryLoadFailed")}</h1>
          <Button onClick={() => void reload()}>
            {t("retry")}
          </Button>
        </section>
      </main>
    );
  }

  const readyCount = songs.filter(song => song.status === "ready").length;

  return (
    <main
      className="libraryPage"
      ref={pageRef}
      onDragOver={event => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={event => event.currentTarget === event.target && setDragging(false)}
      onDrop={handleDrop}
    >
      {dragging && <div className="dropOverlay">{t("dropToImport")}</div>}
      <section className="libraryContent" aria-labelledby={titleId}>
        <LibraryHeader titleId={titleId} songCount={songs.length} readyCount={readyCount} />
        <LibraryActions
          query={query}
          filters={{ status, sort: preferences.librarySort }}
          activeJobs={activeJobs}
          onQueryChange={value => {
            setQuery(value);
            publishSharedView(value, status, preferences.librarySort);
          }}
          onFiltersApply={filters => {
            setStatus(filters.status);
            updatePreferences({ librarySort: filters.sort });
            publishSharedView(query, filters.status, filters.sort);
          }}
          onOpenRoom={() => setRoomOpen(true)}
          onOpenProcessing={() => {
            setFocusSongId(undefined);
            setProcessingOpen(true);
          }}
          onAddSong={() => void addSong()}
        />
        {visibleSongs.length > 0 ? (
          <VirtualGrid
            items={visibleSongs}
            itemKey={song => song.id}
            itemHeight={cardHeight}
            minColumnWidth={255}
            gap={16}
            scrollParent={pageRef}
            label={t("library")}
            renderItem={song => (
              <SongCard
                song={song}
                handlers={handlers}
                roomSelection={room?.role === "host" && song.status === "ready"
                  ? { selected: room.songId === song.id, onSelect: item => void selectRoomSong(item) }
                  : undefined}
              />
            )}
          />
        ) : (
          <LibraryEmptyState
            kind={songs.length === 0 ? "firstRun" : "noResults"}
            onAddSong={() => void addSong()}
            onOpenAudioSettings={() => openSettings("audio")}
            onOpenModels={() => openSettings("ai")}
          />
        )}
      </section>
      <AddSongModal
        open={addOpen}
        initialPath={droppedPath}
        onClose={() => setAddOpen(false)}
        onImport={handleImport}
      />
      <RoomModal open={roomOpen} onClose={() => setRoomOpen(false)} />
      <ProcessingModal
        open={processingOpen}
        songs={songs}
        focusSongId={focusSongId}
        onClose={() => setProcessingOpen(false)}
        onCancel={jobId => guarded(() => cancelJob(jobId))}
        onRetry={song => startProcessing(song)}
      />
      <SongSettingsModal
        song={settingsSong}
        onClose={() => setSettingsSong(null)}
        onSave={handleSaveSong}
        onOpenFolder={handlers.onOpenFolder}
        onReprocess={song => {
          setSettingsSong(null);
          void startProcessing(song);
        }}
        onDelete={handlers.onDelete}
      />
      <RecordingsModal
        song={songRecordings.song}
        recordings={songRecordings.recordings}
        onClose={songRecordings.close}
        onAnalyze={recording => void songRecordings.analyze(recording)}
        onDelete={recording => void songRecordings.remove(recording)}
      />
      <PerformanceAnalysisModal
        analysis={songRecordings.analysis}
        recordings={songRecordings.recordings}
        onDelete={recording => void songRecordings.remove(recording)}
        onClose={songRecordings.closeAnalysis}
      />
      {launching && <div className="sceneCurtain" aria-hidden />}
    </main>
  );
};
