import { observer } from "mobx-react-lite";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Button, Card, Stack, StatusIndicator, tr } from "@neo-ui-kit/react";
import { store } from "../../../providers/store";
import { ask } from "../../../providers/dialog";
import { useNotify } from "../../../providers/notifications";
import { ru } from "../../../i18n/messages.ru";
import type { SongDto } from "../../../contracts/models";
import { LibraryEmptyState } from "../empty-library";
import { SongCard } from "./song-grid/song-card";
import { VirtualGrid } from "./song-grid";
import type { useLibrarySongs } from "./useLibrarySongs";
import type { useRoomLibrary } from "./useRoomLibrary";

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

interface LibrarySongsProps {
  pageRef: RefObject<HTMLElement | null>;
  library: ReturnType<typeof useLibrarySongs>;
  songs: readonly SongDto[];
  localSongs: readonly SongDto[];
  visibleSongs: readonly SongDto[];
  completeCatalog: boolean;
  selecting: boolean;
  setSelecting(value: boolean): void;
  onPlay(song: SongDto, rehearsal?: boolean): void;
  songSelection: ReturnType<typeof useRoomLibrary>["songSelection"];
}

const LibrarySongs = observer(({ pageRef, library, songs, localSongs, visibleSongs,
  completeCatalog, selecting, setSelecting, onPlay, songSelection }: LibrarySongsProps) => {
  const { state } = library;
  const { localProcessing } = store.application;
  const { openSettings } = store;
  const notify = useNotify();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const latestPlay = useRef(onPlay);
  useLayoutEffect(() => { latestPlay.current = onPlay; });
  const play = useMemo(() => (song: SongDto, rehearsal?: boolean) => latestPlay.current(song, rehearsal), []);
  useRememberedScroll(pageRef, state.status === "ready");
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

  return <>
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
                onPlay={play}
                playbackDisabled={localProcessing || selecting || library.stale}
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
            kind={(completeCatalog ? songs.length === 0 : library.summary?.total === 0) ? "firstRun" : "noResults"}
            onOpenAudioSettings={() => openSettings("audio")}
            onOpenModels={() => openSettings("ai")}
          />
        )}
        {library.fetching && state.status === "ready" && <StatusIndicator status="processing" label={tr('library.loading')} />}
        {(library.pageError || library.summaryError) && <Card title={tr(ru.libraryLoadFailed)} actions={<Button icon="refresh" label={tr(ru.retry)} onClick={() => void library.reload()} />} />}

  </>;
});

export default LibrarySongs;
