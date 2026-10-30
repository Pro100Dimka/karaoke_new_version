import type { LibraryViewFilters } from "../hero/search-field";
import { openSettings } from "../modals/settings";
import { createPortal } from "react-dom";
import { mergeRoomLibrary } from "../../../application/room/roomLibrary";
import { loadLastPlayed } from "./lastPlayed";
import { selectLibrarySongs } from "./librarySelectors";
import type { LibraryFilters } from "../hero/actions";
import { observer } from "mobx-react-lite";
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Button, Card, Stack, StatusIndicator, tr } from "@neo-ui-kit/react";
import { store } from "../../../providers/store";
import { ask } from "../../../providers/dialog";
import { useNotify } from "../../../providers/notifications";
import { ru } from "../../../i18n/messages.ru";
import type { SongDto } from "../../../contracts/models";
import { RecordingsModal } from "../modals/recordings";
import { SongSettingsModal } from "../modals/song-settings";
import { LibraryEmptyState } from "../empty-library";
import { SongCard } from "./song-grid/song-card";
import { VirtualGrid } from "./song-grid";
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { songsQuery, songSummaryQuery, refreshSongs } from "../../../api/api-service";
import { pythonClient } from "../../../services/pythonClient";
import { libraryChanged, onLibraryChange } from "../../../services/backendEvents";
import { useJobs } from "../../../providers/application";
import { curtainMilliseconds } from "./useSongActions";
import type { useRoomLibrary } from "./useRoomLibrary";

const emptyImports: readonly SongDto[] = [];

const activeJobStatuses = new Set<SongDto["status"]>(["queued", "processing"]);

/** Keeps the scroll position across visits: restored once the list exists, remembered on leaving. */
const useRememberedScroll = (
  pageRef: RefObject<HTMLElement | null>,
  listReady: boolean,
) => {
  const restored = useRef(false);
  useEffect(() => {
    const page = pageRef.current;
    if (!page || !listReady || restored.current) return;
    // The virtual grid establishes its measured height during the first frame.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        restored.current = true;
        try { page.scrollTop = Number(sessionStorage.getItem("adVoice.libraryScroll")) || 0; } catch { /* Keep the initial position. */ }
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [pageRef, listReady]);
  useLayoutEffect(() => {
    const page = pageRef.current;
    return () => {
      try { if (page) sessionStorage.setItem("adVoice.libraryScroll", String(page.scrollTop)); } catch { /* Scroll restoration is optional. */ }
    };
  }, [pageRef]);
};

interface LibrarySongsProps {
  view: { query: string; filters: LibraryViewFilters };
  onOpenProcessing(songId: string): void;
  pageRef: RefObject<HTMLElement | null>;
  onPlay(song: SongDto, rehearsal?: boolean): void;
  songSelection: ReturnType<typeof useRoomLibrary>["songSelection"];
}

const LibrarySongs = observer(({ view, pageRef, onPlay, onOpenProcessing, songSelection }: LibrarySongsProps) => {
  const { room } = store.online;
  const { preferences } = store;
  const { query, filters: viewFilters } = view;
  const [recordingsSong, setRecordingsSong] = useState<SongDto | null>(null);
  const [analysisRecordId, setAnalysisRecordId] = useState<string | null>(null);
  const clearRecordingsRequest = useCallback(() => setRecordingsSong(null), []);
  const [settingsSong, setSettingsSong] = useState<SongDto | null>(null);
  const [selecting, setSelecting] = useState(false);
  const deferredQuery = useDeferredValue(query);
  const filters: LibraryFilters = useMemo(
    () => ({
      ...viewFilters,
      sort: preferences.librarySort,
      direction: preferences.librarySortDirection,
    }),
    [viewFilters, preferences.librarySort, preferences.librarySortDirection],
  );
  const completeCatalog = !!room || selecting || filters.sort === "played";
  const serverFilter = useMemo(() => ({ ...filters, query: deferredQuery }), [filters, deferredQuery]);
  const client = useQueryClient();
  const { pythonEpoch } = store.application.services;
  const { jobs } = useJobs();
  const queryOptions = songsQuery(pythonEpoch, completeCatalog ? undefined : serverFilter);
  const catalog = useInfiniteQuery({ ...queryOptions, placeholderData: keepPreviousData });
  const summary = useQuery({ ...songSummaryQuery(pythonEpoch), enabled: false });
  const { data: imports = emptyImports } = useQuery<readonly SongDto[]>({ queryKey: ["song-imports"], enabled: false });
  useEffect(() => {
    client.removeQueries({ queryKey: ["songs"], type: "inactive" });
  }, [client, pythonEpoch, completeCatalog, serverFilter]);
  useEffect(() => onLibraryChange(() => { void refreshSongs(client); }), [client]);
  const jobStates = jobs.map(job => `${job.id}:${job.state}`).join("|");
  const previousJobs = useRef(jobStates);
  useEffect(() => {
    if (previousJobs.current === jobStates) return;
    previousJobs.current = jobStates;
    libraryChanged();
  }, [jobStates]);
  const localSongs = useMemo(() => {
    const songs = catalog.data?.pages.flatMap(page => page.items);
    if (!songs) return [];
    const active = new Map(jobs.filter(job => ["queued", "processing", "cancelling"].includes(job.state)).map(job => [job.songId, job]));
    return [...imports, ...songs].map(song => {
      const job = active.get(song.id);
      return job ? { ...song, jobId: job.id, stage: job.stage, progress: job.progress,
        status: job.state === "queued" ? "queued" as const : "processing" as const } : song;
    });
  }, [catalog.data, imports, jobs]);
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

  const entrance = store.playback.returned;
  const [returning, setReturning] = useState(Boolean(entrance?.performanceReturn));
  const reveal = (!!catalog.data || catalog.isError) && (!entrance?.analysisFor ||
    analysisRecordId === entrance.analysisFor || catalog.isError);
  useEffect(() => {
    if (!returning || !reveal) return;
    const timer = window.setTimeout(() => setReturning(false), curtainMilliseconds);
    return () => window.clearTimeout(timer);
  }, [returning, reveal]);

  const { localProcessing } = store.application;
  const notify = useNotify();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const latestPlay = useRef(onPlay);
  useLayoutEffect(() => { latestPlay.current = onPlay; });
  const play = useMemo(() => (song: SongDto, rehearsal?: boolean) => latestPlay.current(song, rehearsal), []);
  useRememberedScroll(pageRef, !!catalog.data);
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
          await pythonClient.deleteSong(song.id);
          await refreshSongs(client);
          setSelected((current) => { const next = new Set(current); next.delete(song.id); return next; });
        } catch (error) {
          notify(`${song.title}: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
      }
    } finally { setDeleting(false); }
  };

  return <>
        <RecordingsModal requestedSong={recordingsSong} onRequestHandled={clearRecordingsRequest}
          onAnalysisReady={setAnalysisRecordId} />
        {settingsSong && <SongSettingsModal key={settingsSong.id} song={settingsSong}
          onClose={() => setSettingsSong(null)} onChange={setSettingsSong} />}
        {returning && pageRef.current && createPortal(<div className="sceneCurtain" data-phase={reveal ? "opening" : "waiting"}
          aria-hidden style={{ animationDirection: "reverse", ...(reveal ? {} : { animation: "none" }) }} />, pageRef.current)}
        {!catalog.data && !catalog.isError ? (
          <Stack align="center" style={{ paddingBlock: 'var(--ad-space-6)' }}>
            <StatusIndicator status="processing" label={tr('library.loading')} />
          </Stack>
        ) : !catalog.data && catalog.isError ? (
          <Card icon="database" title={tr(ru['libraryLoadFailed'])} material="glass" padding="lg"
            style={{ width: 'min(100%, 40rem)', alignSelf: 'center', marginBlock: 'clamp(1rem, 4vh, 3rem)' }}
            actions={<Button icon="refresh" label={tr(ru['retry'])} onClick={() => void refreshSongs(client)} />} />
        ) : visibleSongs.length > 0 ? (
          <>
          <Stack direction="row" gap={2} wrap style={{ marginBottom: 16 }}>
            <Button icon="check" disabled={deleting || catalog.isPlaceholderData} onClick={() => { setSelecting(!selecting); setSelected(new Set()); }}>
              {selecting ? tr(ru.cancel) : tr("Выбрать несколько")}
            </Button>
            {selecting && <>
              <Button disabled={deleting || catalog.isPlaceholderData} onClick={() => setSelected(new Set(visibleSongs
                .filter((song) => !song.roomOwnerId && !activeJobStatuses.has(song.status)).map((song) => song.id)))}>
                {tr("Выбрать все показанные")}
              </Button>
              <Button icon="trash" disabled={deleting || catalog.isPlaceholderData || !selected.size} onClick={() => void deleteSelected()}>
                {tr("Удалить выбранные ({count})", { count: selected.size })}
              </Button>
            </>}
          </Stack>
          <VirtualGrid
            items={visibleSongs}
            hasNextPage={(catalog.hasNextPage && !catalog.isPlaceholderData && !catalog.isError)}
            loading={catalog.isFetching}
            loadMore={catalog.fetchNextPage}
            itemKey={(song) => song.id}
            scrollParent={pageRef}
            label={tr(ru.library)}
            renderItem={(song) => (
              <SongCard
                song={song}
                onOpenSettings={setSettingsSong}
                onOpenRecordings={setRecordingsSong}
                onPlay={play}
                onOpenProcessing={onOpenProcessing}
                playbackDisabled={localProcessing || selecting || catalog.isPlaceholderData}
                selection={selecting && !song.roomOwnerId ? {
                  checked: selected.has(song.id), disabled: deleting || activeJobStatuses.has(song.status),
                  toggle: () => setSelected((current) => {
                    const next = new Set(current);
                    if (next.has(song.id)) next.delete(song.id); else next.add(song.id);
                    return next;
                  }),
                } : undefined}
                roomSelection={songSelection(song)}
              />
            )}
          />
          </>
        ) : (
          <LibraryEmptyState
            kind={(completeCatalog ? songs.length === 0 : summary.data?.total === 0) ? "firstRun" : "noResults"}
            onOpenAudioSettings={() => openSettings("audio")}
            onOpenModels={() => openSettings("ai")}
          />
        )}
        {catalog.isFetching && !!catalog.data && <StatusIndicator status="processing" label={tr('library.loading')} />}
        {(catalog.isFetchNextPageError || summary.isError) && <Card title={tr(ru.libraryLoadFailed)} actions={<Button icon="refresh" label={tr(ru.retry)} onClick={() => void refreshSongs(client)} />} />}

  </>;
});

export default LibrarySongs;
