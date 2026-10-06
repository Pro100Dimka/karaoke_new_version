import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "../../app/AppContext";
import { useNotify } from "../../app/NotificationsProvider";
import { routes } from "../../app/routes";
import { useServices } from "../../app/ServicesContext";
import type {
  ImportMetadata,
  ImportOptions,
  SongPatch,
} from "../../contracts/clients";
import type { SongDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { desktopClient } from "../../services/desktopClient";
import { roomClient } from "../../services/roomClient";
import { participantId, sharedStateOf } from "../../services/roomMappers";
import { errorMessageKey, toAppError } from "../../shared/errors";
import { useDebouncedValue } from "../../shared/hooks/useDebouncedValue";
import { Button, Card, EmptyState, Shimmer } from "@ad-voice/ui";
import { mergeRoomLibrary } from "../room/roomLibrary";
import { RoomModal } from "../room/RoomModal";
import {
  canControlRoom,
  encodeSharedLibraryView,
  sharedLibraryView,
} from "../room/roomModel";
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
import { useLibrarySongs } from "./useLibrarySongs";
import { dragLeavesBoundary } from "./fileDrag";
import { useSongActions } from "./useSongActions";
import { useSongRecordings } from "./useSongRecordings";
import { VirtualGrid } from "./VirtualGrid";

/** Placeholder cards shown in the grid's place while the songs load. */
const skeletonCards = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
] as const;

const searchDebounceMilliseconds = 150;
const curtainMilliseconds = 400;
const cardHeight = 187;
const cardAspectRatio = 1.62;

export const LibraryPage = () => {
  const navigate = useNavigate();
  const t = useText();
  const notify = useNotify();
  const guarded = useGuardedAction();
  const titleId = useId();
  const errorTitleId = useId();
  const pageRef = useRef<HTMLElement>(null);
  const { preferences, updatePreferences, openSettings, room, setRoom } =
    useApp();
  const { python } = useServices();
  const {
    state,
    reload,
    refresh,
    importSong,
    processSong,
    cancelJob,
    updateSong,
    removeSongCover,
    deleteSong,
  } = useLibrarySongs();

  const [query, setQuery] = useState(libraryViewState.query);
  const [viewFilters, setViewFilters] = useState(libraryViewState.filters);
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
    libraryViewState.filters = viewFilters;
  }, [query, viewFilters]);

  // In a room the shared view is authoritative; the local one follows it.
  useEffect(() => {
    if (!room) return;
    const {
      query: sharedQuery,
      sort,
      direction,
      ...shared
    } = sharedLibraryView(room);
    setQuery(sharedQuery);
    setViewFilters((current) =>
      (Object.keys(shared) as (keyof typeof shared)[]).every(
        (key) => current[key] === shared[key],
      )
        ? current
        : shared,
    );
    if (
      preferences.librarySort !== sort ||
      preferences.librarySortDirection !== direction
    )
      updatePreferences({ librarySort: sort, librarySortDirection: direction });
  }, [
    room,
    preferences.librarySort,
    preferences.librarySortDirection,
    updatePreferences,
  ]);

  const publishSharedView = (nextQuery: string, filters: LibraryFilters) => {
    if (!room || !canControlRoom(room)) return;
    const shared = encodeSharedLibraryView(filters);
    void roomClient
      .updateSharedState(room.code, {
        ...sharedStateOf(room),
        libraryQuery: nextQuery,
        ...shared,
      })
      .then(setRoom)
      .catch(() => undefined);
  };

  const localSongs = useMemo(
    () => (state.status === "ready" ? state.songs : []),
    [state],
  );
  const songs = useMemo(
    () => mergeRoomLibrary(localSongs, room?.sharedSongs ?? [], participantId),
    [localSongs, room?.sharedSongs],
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
    () =>
      selectLibrarySongs(songs, { query: debouncedQuery, ...filters }, played),
    [songs, debouncedQuery, filters, played],
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
  const songRecordings = useSongRecordings(
    songs,
    state.status === "ready",
    refresh,
  );
  const { startProcessing, confirmDelete, showError } = useSongActions(
    { processSong, deleteSong },
    () => setSettingsSong(null),
  );

  async function selectRoomSong(song: SongDto): Promise<void> {
    if (!room || !canControlRoom(room)) return;
    try {
      setRoom(
        await roomClient.selectRoomSong(
          room.code,
          song.id,
          song.activeRevision,
        ),
      );
    } catch (error) {
      notify(
        t(errorMessageKey(toAppError(error)) ?? "roomNetworkUnavailable"),
        "error",
      );
    }
  }

  const handlers: SongCardHandlers = {
    onPlay: (song) => {
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
      window.setTimeout(
        () =>
          navigate(routes.karaoke(song.id), { state: { mode: "AutoStart" } }),
        curtainMilliseconds,
      );
    },
    onProcess: (song) => void startProcessing(song),
    onCancel: (song) =>
      song.jobId && void guarded(() => cancelJob(song.jobId as string)),
    onDetails: (song) => {
      setFocusSongId(song.id);
      setProcessingOpen(true);
    },
    onSettings: setSettingsSong,
    onRecordings: (song) => void songRecordings.open(song),
    onOpenFolder: (song) =>
      void desktopClient.revealProject(song.id, song.activeRevision),
    onDelete: (song) => void confirmDelete(song),
    onViewError: (song) => void showError(song),
  };

  const latestHandlers = useRef(handlers);
  latestHandlers.current = handlers;
  const cardHandlers = useMemo(() => Object.fromEntries(
    (Object.keys(handlers) as (keyof SongCardHandlers)[]).map(key =>
      [key, (song: SongDto) => latestHandlers.current[key](song)]),
  ) as SongCardHandlers, []);

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

  const handleImport = async (
    path: string,
    metadata: ImportMetadata,
    options?: ImportOptions,
  ) => {
    const song = await importSong(path, metadata, options);
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
        notify(
          t(errorMessageKey(toAppError(error)) ?? "importFailed"),
          "error",
        );
      }
    });

  const activeJobs = localSongs.filter(
    (song) => song.status === "queued" || song.status === "processing",
  ).length;

  if (state.status === "loading") {
    return (
      <main className="libraryPage" ref={pageRef}>
        <div
          className="librarySkeleton"
          aria-live="polite"
          aria-busy="true"
          aria-label={t("loadingLibrary")}
        >
          {skeletonCards.map((id) => (
            <Card key={id} border padding="md">
              <Shimmer lines={3} circle />
            </Card>
          ))}
        </div>
      </main>
    );
  }

  if (state.status === "error") {
    return (
      <main className="libraryPage" ref={pageRef}>
        <section
          className="libraryState"
          id={errorTitleId}
          aria-label={t("libraryLoadFailed")}
        >
          <EmptyState
            icon="warning"
            title={t("libraryLoadFailed")}
            action={
              <Button
                variant="primary"
                icon="refresh"
                onClick={() => void reload()}
              >
                {t("retry")}
              </Button>
            }
          />
        </section>
      </main>
    );
  }

  const readyCount = songs.filter((song) => song.status === "ready").length;

  return (
    <main
      className="libraryPage"
      ref={pageRef}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (dragLeavesBoundary(event.currentTarget, event.relatedTarget))
          setDragging(false);
      }}
      onDrop={handleDrop}
    >
      {dragging && <div className="dropOverlay">{t("dropToImport")}</div>}
      <section className="libraryContent" aria-labelledby={titleId}>
        <LibraryHeader
          titleId={titleId}
          songCount={songs.length}
          readyCount={readyCount}
        />
        <LibraryActions
          query={query}
          filters={filters}
          activeJobs={activeJobs}
          roomRole={room?.role}
          collaborativeControl={room?.collaborativeControl}
          onCollaborativeControlChange={(enabled) => {
            if (!room || room.role !== "host") return;
            void roomClient
              .setCollaborativeControl(room.code, enabled)
              .then(setRoom)
              .catch((error) =>
                notify(
                  t(
                    errorMessageKey(toAppError(error)) ??
                      "roomNetworkUnavailable",
                  ),
                  "error",
                ),
              );
          }}
          onQueryChange={(value) => {
            if (room && !canControlRoom(room)) return;
            setQuery(value);
            publishSharedView(value, filters);
          }}
          onFiltersApply={(nextFilters) => {
            if (room && !canControlRoom(room)) return;
            const { sort, direction, ...next } = nextFilters;
            setViewFilters(next);
            updatePreferences({
              librarySort: sort,
              librarySortDirection: direction,
            });
            publishSharedView(query, nextFilters);
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
                roomSelection={
                  room && canControlRoom(room) && song.status === "ready"
                    ? {
                        role: room.role,
                        selected: room.songId === song.id,
                      }
                    : undefined
                }
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
        onCancel={(jobId) => guarded(() => cancelJob(jobId))}
        onRetry={(song) => startProcessing(song)}
        onOpenFolder={handlers.onOpenFolder}
        onPlay={handlers.onPlay}
      />
      <SongSettingsModal
        song={settingsSong}
        onClose={() => setSettingsSong(null)}
        onSave={handleSaveSong}
        onRemoveCover={async (song) => {
          const saved = await removeSongCover(song);
          setSettingsSong(saved);
        }}
        onOpenFolder={handlers.onOpenFolder}
        onReprocess={(song) => {
          setSettingsSong(null);
          void startProcessing(song);
        }}
        onDelete={handlers.onDelete}
      />
      <RecordingsModal
        song={songRecordings.song}
        recordings={songRecordings.recordings}
        onClose={songRecordings.close}
        onAnalyze={(recording) => void songRecordings.analyze(recording)}
        onRename={(recording, name) =>
          void songRecordings.rename(recording, name)
        }
        onDelete={(recording) => void songRecordings.remove(recording)}
      />
      <PerformanceAnalysisModal
        analysis={songRecordings.analysis}
        recordings={songRecordings.recordings}
        onDelete={(recording) => void songRecordings.remove(recording)}
        onCreateStudioMaster={(recording) =>
          void songRecordings.createStudioMaster(recording)
        }
        studioMaster={songRecordings.studioMaster}
        onClose={songRecordings.closeAnalysis}
      />
      {launching && <div className="sceneCurtain" aria-hidden />}
    </main>
  );
};
