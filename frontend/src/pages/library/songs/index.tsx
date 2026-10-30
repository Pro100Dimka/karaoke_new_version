import { observer } from "mobx-react-lite";
import { store } from "../../../providers/store";
import { desktopClient as files } from "../../../services/desktopClient";
import {
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useRouter, Button, Card, Stack, StatusIndicator, tr, useLocale } from "@neo-ui-kit/react";
import { useJobs } from "../../../providers/application";
import { useNotify } from "../../../providers/notifications";
import { routes } from "../../../shared/routes";

import type { SongPatch } from "../../../contracts/clients";
import type { SongDto } from "../../../contracts/models";
import { ru } from "../../../i18n/messages.ru";

import { mergeRoomLibrary } from "../../../application/room/roomLibrary";
import { RoomModal } from "../../../features/room/RoomModal";
import { roomSongPlayIntent } from "../../../features/room/roomSongIntent";
import { AddSongModal } from "../modals/add-song/index";
import { loadLastPlayed, markPlayed } from "./lastPlayed";
import "../library.css";
import { LibraryActions, type LibraryFilters } from "../hero/actions";
import { LibraryEmptyState } from "../empty-library";
import { LibraryHeader } from "../hero/index";
import { selectLibrarySongs } from "./librarySelectors";
import { PerformanceAnalysisModal } from "../modals/analysis/index";
import { ProcessingModal } from "../modals/processing/index";
import { RecordingsModal } from "../modals/recordings/index";
import { SongCard, type SongCardHandlers } from "./song-grid/song-card/index";
import { SongSettingsModal } from "../modals/song-settings/index";
import { useGuardedAction } from "./useGuardedAction";
import { useLibraryImport } from "../modals/add-song/useLibraryImport";
import { libraryCommands } from "../../../app/desktop/shellBus";
import { ask } from "../../../providers/dialog";
import { useKaraokeTv } from "../../../features/karaoke/tv/karaokeTv";
import { useLibrarySongs } from "./useLibrarySongs";
import { useRoomLibrary } from "./useRoomLibrary";
import { useSongActions } from "./useSongActions";
import { useSongRecordings } from "./useSongRecordings";
import { VirtualGrid } from "./song-grid/index";

const activeJobStatuses = new Set<SongDto["status"]>(["queued", "processing"]);
const curtainMilliseconds = 400;

/** Keeps the scroll position across visits: restored once the list exists, remembered on leaving. */
const useRememberedScroll = (
  pageRef: RefObject<HTMLElement | null>,
  listReady: boolean,
) => {
  const restored = useRef(false);
  useEffect(() => {
    const page = pageRef.current;
    if (!page || !listReady || restored.current) return;
    restored.current = true;
    page.scrollTop = store.library.scrollTop;
  }, [pageRef, listReady]);
  useEffect(() => {
    const page = pageRef.current;
    return () => {
      if (page) store.library.scrollTop = page.scrollTop;
    };
  }, [pageRef]);
};

/** Card handlers that keep their identity across renders (the virtual grid keeps cards mounted)
 * while always calling the page's latest handlers. */
const useStableCardHandlers = (
  handlers: SongCardHandlers,
): SongCardHandlers => {
  const latest = useRef(handlers);
  useLayoutEffect(() => {
    latest.current = handlers;
  });
  return useMemo<SongCardHandlers>(
    () => ({
      onPlay: (song) => latest.current.onPlay(song),
      onRehearse: (song) => latest.current.onRehearse?.(song),
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

const LibrarySongs = observer(({ pageRef }: { pageRef: RefObject<HTMLElement | null> }) => {
  const { navigate } = useRouter();
  const entrance = store.playback.returned;
  const [returning, setReturning] = useState(
    Boolean(entrance?.performanceReturn),
  );
  const titleId = useId();
  useLocale();
  const notify = useNotify();
  const guarded = useGuardedAction();
  const { preferences, updatePreferences } = store;
  const { localProcessing } = store.application;
  const { jobs } = useJobs();
  const { openSettings } = store;
  const processing = useRef(localProcessing);
  processing.current = localProcessing;
  const { python } = store.application.services;

  const [query, setQuery] = useState(store.library.query);
  const [viewFilters, setViewFilters] = useState(store.library.filters);
  const [roomOpen, setRoomOpen] = useState(false);
  const [invitationCode, setInvitationCode] = useState<string>();
  const [processingOpen, setProcessingOpen] = useState(false);
  const [focusSongId, setFocusSongId] = useState<string | undefined>();
  const [settingsSong, setSettingsSong] = useState<SongDto | null>(null);
  const [launching, setLaunching] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const deferredQuery = useDeferredValue(query);
  const roomLibrary = useRoomLibrary({ setQuery, setViewFilters });
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

  useEffect(() => {
    store.library.query = query;
    store.library.filters = viewFilters;
  }, [query, viewFilters]);
  useRememberedScroll(pageRef, state.status === "ready");

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

  const songRecordings = useSongRecordings(
    songs,
    state.status === "ready",
    library.refresh,
  );
  const reveal =
    state.status !== "loading" &&
    (!entrance?.analysisFor ||
      songRecordings.analysisRecordId === entrance.analysisFor ||
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
  const { startProcessing, confirmDelete, showError } = useSongActions(
    library,
    () => setSettingsSong(null),
  );
  const songImport = useLibraryImport({
    importSong: library.importSong,
    startProcessing,
    guarded,
    backendReady: python.kind === "ready",
  });
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

  const tv = useKaraokeTv();
  const deleteSelected = async () => {
    const targets = localSongs.filter((song) => selected.has(song.id) && !activeJobStatuses.has(song.status));
    if (!targets.length || deleting) return;
    const choice = await ask({
      title: tr("Удалить выбранные песни ({count})?", { count: targets.length }),
      body: tr("Будут удалены выбранные песни, их обработки и записи. Это действие нельзя отменить."),
      tone: "warning",
      actions: [{ id: "cancel", label: tr(ru.cancel) }, { id: "delete", label: tr("Удалить"), appearance: "primary" }],
    });
    if (choice !== "delete") return;
    setDeleting(true);
    try {
      for (const song of targets) {
        try {
          await library.deleteSong(song);
          setSelected((current) => { const next = new Set(current); next.delete(song.id); return next; });
        } catch (error) {
          notify(`${song.title}: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
      }
    } finally { setDeleting(false); }
  };
  // While someone sings on the TV a chosen song waits its turn there, or replaces the current one.
  const playOnTv = async (song: SongDto, rehearsal = false) => {
    if (!tv) return;
    const current = songs.find((item) => item.id === tv.songId);
    if (song.id === tv.songId) return;
    const choice = await ask({
      title: tr(ru.tvBusyTitle),
      body: tr(ru.tvBusyBody, {
        current: current?.title ?? "…",
        title: song.title,
      }),
      actions: [
        { id: "cancel", label: tr(ru.cancel) },
        { id: "next", label: tr(ru.tvQueueNext) },
        { id: "now", label: tr(ru.tvReplaceNow), appearance: "primary" },
      ],
    });
    if (processing.current || !["next", "now"].includes(choice ?? "")) return;
    markPlayed(song.id);
    tv.play(
      { id: song.id, title: song.title, artist: song.artist, rehearsal },
      choice === "next" ? "next" : "now",
    );
    if (choice === "next")
      notify(tr(ru.tvQueued, { title: song.title }), "success");
  };

  const playSong = (song: SongDto, rehearsal = false) => {
    if (processing.current) return;
    if (tv?.active) {
      void playOnTv(song, rehearsal);
      return;
    }
    const intent = roomSongPlayIntent(room);
    if (intent === "select-room") {
      void roomLibrary.selectSong(song);
      return;
    }
    if (intent === "wait-for-host") {
      notify(tr(ru.errorRoomPermission), "warning");
      return;
    }
    markPlayed(song.id);
    setLaunching(true);
    window.setTimeout(() => {
      if (processing.current) setLaunching(false);
      else {
        store.prepareKaraoke(song.id, rehearsal ? "Rehearsal" : "AutoStart");
        navigate(routes.karaoke(song.id));
      }
    }, curtainMilliseconds);
  };
  const openFolder = (song: SongDto) =>
    void files.revealProject(song.id, song.activeRevision);
  const openProcessing = (songId?: string) => {
    setFocusSongId(songId);
    setProcessingOpen(true);
  };

  const cardHandlers = useStableCardHandlers({
    onPlay: playSong,
    onRehearse: (song) => playSong(song, true),
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

  const activeJobs = jobs.filter((job) => job.type === "SongProcessing" && ["queued", "processing", "cancelling"].includes(job.state)).length;
  const readyCount = songs.filter((song) => song.status === "ready").length;
  const addSong = () => void songImport.addSong();

  return (
    <div style={{ minHeight: "100%" }} {...songImport.dropTarget}>
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
        {state.status === 'loading' ? (
          <Stack align="center" style={{ paddingBlock: 'var(--ad-space-6)' }}>
            <StatusIndicator status="processing" label={tr('library.loading')} />
          </Stack>
        ) : state.status === 'error' ? (
          <Card icon="database" title={tr(ru['libraryLoadFailed'])} material="glass" padding="lg"
            style={{ width: 'min(100%, 40rem)', alignSelf: 'center', marginBlock: 'clamp(1rem, 4vh, 3rem)' }}
            actions={<Button icon="refresh" label={tr(ru['retry'])} onClick={() => void library.reload()} />} />
        ) : visibleSongs.length > 0 ? (
          <>
          <Stack direction="row" gap={2} wrap style={{ marginBottom: 16 }}>
            <Button icon="check" disabled={deleting || library.stale} onClick={() => { setSelecting(!selecting); setSelected(new Set()); }}>
              {selecting ? tr(ru.cancel) : tr("Выбрать несколько")}
            </Button>
            {selecting && <>
              <Button disabled={deleting || library.stale} onClick={() => setSelected(new Set(visibleSongs
                .filter((song) => !song.roomOwnerId && !activeJobStatuses.has(song.status)).map((song) => song.id)))}>
                {tr("Выбрать все показанные")}
              </Button>
              <Button icon="trash" disabled={deleting || library.stale || !selected.size} onClick={() => void deleteSelected()}>
                {tr("Удалить выбранные ({count})", { count: selected.size })}
              </Button>
            </>}
          </Stack>
          <VirtualGrid
            items={visibleSongs}
            hasNextPage={library.hasNextPage}
            loading={library.fetching}
            loadMore={library.fetchNextPage}
            itemKey={(song) => song.id}
            scrollParent={pageRef}
            label={tr(ru.library)}
            renderItem={(song) => (
              <SongCard
                song={song}
                handlers={cardHandlers}
                playbackDisabled={localProcessing || selecting || library.stale}
                selection={selecting && !song.roomOwnerId ? {
                  checked: selected.has(song.id), disabled: deleting || activeJobStatuses.has(song.status),
                  toggle: () => setSelected((current) => {
                    const next = new Set(current);
                    if (next.has(song.id)) next.delete(song.id); else next.add(song.id);
                    return next;
                  }),
                } : undefined}
                roomSelection={roomLibrary.songSelection(song)}
              />
            )}
          />
          </>
        ) : (
          <LibraryEmptyState
            kind={(completeCatalog ? songs.length === 0 : library.summary?.total === 0) ? "firstRun" : "noResults"}
            onOpenAudioSettings={() => openSettings("audio")}
            onOpenModels={() => openSettings("ai")}
          />
        )}
        {library.fetching && state.status === "ready" && <StatusIndicator status="processing" label={tr('library.loading')} />}
        {(library.pageError || library.summaryError) && <Card title={tr(ru.libraryLoadFailed)} actions={<Button icon="refresh" label={tr(ru.retry)} onClick={() => void library.reload()} />} />}
      </Stack>
      <AddSongModal
        {...songImport.addDialog}
        onImport={songImport.handleImport}
      />
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
        onClose={() => setProcessingOpen(false)}
        onCancel={(jobId) => guarded(() => library.cancelJob(jobId))}
        onOpenFolder={openFolder}
        onPlay={playSong}
        playbackDisabled={localProcessing}
      />
      <SongSettingsModal
        song={settingsSong}
        onClose={() => setSettingsSong(null)}
        onSave={handleSaveSong}
        onRemoveCover={async (song) =>
          setSettingsSong(await library.removeSongCover(song))
        }
        onOpenFolder={openFolder}
        onDelete={(song) => void confirmDelete(song)}
      />
      <RecordingsModal
        song={songRecordings.song}
        recordings={songRecordings.recordings}
        onClose={songRecordings.close}
        onAnalyze={songRecordings.analyze}
        progress={songRecordings.analysisProgress}
        failures={songRecordings.analysisFailures}
        onCancelAnalysis={songRecordings.cancelAnalysis}
        onRename={songRecordings.rename}
        onDelete={songRecordings.remove}
      />
      <PerformanceAnalysisModal
        analysis={songRecordings.analysis}
        song={songRecordings.analysisSong}
        recordingId={songRecordings.analysisRecordId ?? undefined}
        pending={
          songRecordings.analysisRecordId
            ? songRecordings.analysisProgress[songRecordings.analysisRecordId]
            : undefined
        }
        failure={
          songRecordings.analysisRecordId
            ? songRecordings.analysisFailures[songRecordings.analysisRecordId]
            : undefined
        }
        onCancelAnalysis={songRecordings.cancelAnalysis}
        recordings={songRecordings.recordings}
        onDelete={songRecordings.remove}
        onCreateStudioMaster={(recording) =>
          void songRecordings.createStudioMaster(recording)
        }
        studioMaster={songRecordings.studioMaster}
        onClose={songRecordings.closeAnalysis}
      />
      {launching && <div className="sceneCurtain" aria-hidden />}
      {returnCurtain}
    </div>
  );
});

export default LibrarySongs;
