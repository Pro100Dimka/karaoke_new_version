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
import { useDebouncedValue } from "../../shared/hooks/useDebouncedValue";
import { RoomModal } from "../room/RoomModal";
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
  const { preferences, updatePreferences, openSettings } = useApp();
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

  const songs = useMemo(() => (state.status === "ready" ? state.songs : []), [state]);
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

  const handlers: SongCardHandlers = {
    onPlay: song => {
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
    await importSong(path, metadata);
    notify(t("songImported"), "success");
  };

  const activeJobs = songs.filter(song => song.status === "queued" || song.status === "processing").length;

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
          onQueryChange={setQuery}
          onFiltersApply={filters => {
            setStatus(filters.status);
            updatePreferences({ librarySort: filters.sort });
          }}
          onOpenRoom={() => setRoomOpen(true)}
          onOpenProcessing={() => {
            setFocusSongId(undefined);
            setProcessingOpen(true);
          }}
          onAddSong={() => {
            setDroppedPath("");
            setAddOpen(true);
          }}
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
            renderItem={song => <SongCard song={song} handlers={handlers} />}
          />
        ) : (
          <LibraryEmptyState
            kind={songs.length === 0 ? "firstRun" : "noResults"}
            onAddSong={() => setAddOpen(true)}
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
