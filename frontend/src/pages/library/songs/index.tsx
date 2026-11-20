import {
  Button,
  Card,
  Stack,
  StatusIndicator,
  tr,
  useRouter,
} from '@neo-ui-kit/react';
import { observer } from 'mobx-react-lite';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { refreshSongs } from '../../../components/api-service';
import type { SongDto } from '../../../contracts/models';
import { ask } from '../../../providers/dialog';
import { useNotify } from '../../../providers/notifications';
import { store } from '../../../providers/store';
import { pythonClient } from '../../../services/pythonClient';
import { LibraryEmptyState } from '../empty-library';
import type { LibraryViewFilters } from '../hero/filters&actions/search-field';
import { RecordingsModal } from '../modals/recordings';
import { openSettings } from '../modals/settings';
import { SongSettingsModal } from '../modals/song-settings';
import { VirtualGrid } from './song-grid';
import { SongCard } from './song-grid/song-card';
import { SelectionToolbar } from './SelectionToolbar';
import type { useRoomLibrary } from './useRoomLibrary';
import { useLibraryCatalog } from './useLibraryCatalog';
import { curtainMilliseconds } from './useSongActions';
import {
  AddToPlaylistDialog,
  PlaylistDialog,
} from '../../../features/playlists/PlaylistDialog';
import { useRoomLibraryCommands } from '../../../providers/application';
import { routes } from '../../../shared/routes';
import { canControlRoom } from '../../../application/room/roomModel';
import { readText, writeText } from '../../../shared/storage/localStore';

const activeJobStatuses = new Set<SongDto['status']>(['queued', 'processing']);

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
        page.scrollTop =
          Number(readText('adVoice.libraryScroll', 'session')) || 0;
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [pageRef, listReady]);
  useLayoutEffect(() => {
    const page = pageRef.current;
    return () => {
      if (page)
        writeText('adVoice.libraryScroll', String(page.scrollTop), 'session');
    };
  }, [pageRef]);
};

interface LibrarySongsProps {
  playlistsOpen: boolean;
  onClosePlaylists(): void;
  onReady(): void;
  view: { query: string; filters: LibraryViewFilters };
  onOpenProcessing(songId: string): void;
  pageRef: RefObject<HTMLElement | null>;
  onPlay(song: SongDto, rehearsal?: boolean): void;
  songSelection: ReturnType<typeof useRoomLibrary>['songSelection'];
}

const LibrarySongs = observer(
  ({
    onReady,
    view,
    pageRef,
    onPlay,
    onOpenProcessing,
    songSelection,
    playlistsOpen,
    onClosePlaylists,
  }: LibrarySongsProps) => {
    const { query, filters: viewFilters } = view;
    const [recordingsSong, setRecordingsSong] = useState<SongDto | null>(null);
    const [analysisRecordId, setAnalysisRecordId] = useState<string | null>(
      null,
    );
    const clearRecordingsRequest = useCallback(
      () => setRecordingsSong(null),
      [],
    );
    const [settingsSong, setSettingsSong] = useState<SongDto | null>(null);
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
    const [addingToPlaylist, setAddingToPlaylist] = useState(false);
    const toggleSelected = useCallback((id: string) => {
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    }, []);
    const selecting = selected.size > 0;
    const { navigate } = useRouter();
    const roomLibrary = useRoomLibraryCommands();
    const {
      catalog,
      summary,
      client,
      localSongs,
      songs,
      visibleSongs,
      completeCatalog,
    } = useLibraryCatalog(query, viewFilters, selecting || playlistsOpen);

    useEffect(() => {
      if (
        !selecting ||
        !completeCatalog ||
        !catalog.data ||
        catalog.isFetching ||
        catalog.isPlaceholderData ||
        catalog.isError
      )
        return;
      // A card or song settings can delete a selected song outside the batch action.
      // Only the complete catalog can distinguish a deletion from a hidden search result.
      const existing = new Set(localSongs.map((song) => song.id));
      setSelected((current) => {
        const next = new Set([...current].filter((id) => existing.has(id)));
        return next.size === current.size ? current : next;
      });
    }, [
      selecting,
      completeCatalog,
      catalog.data,
      catalog.isFetching,
      catalog.isPlaceholderData,
      catalog.isError,
      localSongs,
    ]);

    const entrance = store.playback.returned;
    const [returning, setReturning] = useState(
      Boolean(entrance?.performanceReturn),
    );
    const reveal =
      (!!catalog.data || catalog.isError) &&
      (!entrance?.analysisFor ||
        analysisRecordId === entrance.analysisFor ||
        catalog.isError);
    useEffect(() => {
      if (!returning || !reveal) return;
      const timer = window.setTimeout(
        () => setReturning(false),
        curtainMilliseconds,
      );
      return () => window.clearTimeout(timer);
    }, [returning, reveal]);

    const { localProcessing } = store.application;
    const notify = useNotify();
    const [deleting, setDeleting] = useState(false);
    const latestPlay = useRef(onPlay);
    useLayoutEffect(() => {
      latestPlay.current = onPlay;
    });
    const play = useMemo(
      () => (song: SongDto, rehearsal?: boolean) =>
        latestPlay.current(song, rehearsal),
      [],
    );
    useRememberedScroll(pageRef, !!catalog.data);
    // Opening/closing a modal must not rebuild the visible virtualized cards.
    // These callbacks change only when the actual card inputs change.
    const itemKey = useCallback((song: SongDto) => song.id, []);
    const renderSong = useCallback(
      (song: SongDto) => (
        <SongCard
          song={song}
          onOpenSettings={setSettingsSong}
          onOpenRecordings={setRecordingsSong}
          onPlay={play}
          onOpenProcessing={onOpenProcessing}
          playbackDisabled={
            localProcessing || selecting || catalog.isPlaceholderData
          }
          selection={
            !song.roomOwnerId
              ? {
                  checked: selected.has(song.id),
                  active: selecting,
                  disabled:
                    deleting ||
                    catalog.isPlaceholderData ||
                    song.status === 'importing',
                  toggle: toggleSelected,
                }
              : undefined
          }
          roomSelection={songSelection(song)}
        />
      ),
      [
        play,
        onOpenProcessing,
        localProcessing,
        selecting,
        catalog.isPlaceholderData,
        selected,
        deleting,
        toggleSelected,
        songSelection,
      ],
    );
    const deleteSelected = async () => {
      const targets = localSongs.filter(
        (song) => selected.has(song.id) && !activeJobStatuses.has(song.status),
      );
      if (!targets.length || deleting) return;
      const choice = await ask({
        title: tr('Удалить выбранные песни ({count})?', {
          count: targets.length,
        }),
        body: tr(
          'Будут удалены выбранные песни, их обработки и записи. Это действие нельзя отменить.',
        ),
        tone: 'warning',
        actions: [
          { id: 'cancel', label: tr('cancel') },
          { id: 'delete', label: tr('Удалить'), appearance: 'primary' },
        ],
      });
      if (choice !== 'delete') return;
      setDeleting(true);
      let changed = false;
      try {
        for (const song of targets) {
          try {
            await pythonClient.deleteSong(song.id);
            changed = true;
            setSelected((current) => {
              const next = new Set(current);
              next.delete(song.id);
              return next;
            });
          } catch (error) {
            notify(
              `${song.title}: ${error instanceof Error ? error.message : String(error)}`,
              'error',
            );
          }
        }
      } finally {
        try {
          if (changed) await refreshSongs(client);
        } finally {
          setDeleting(false);
        }
      }
    };

    const isLoadingCatalog = !catalog.data && !catalog.isError;
    useEffect(() => {
      if (isLoadingCatalog) return;
      // Let the virtual grid attach and lay out its rows beneath the curtain.
      let frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(onReady);
      });
      return () => cancelAnimationFrame(frame);
    }, [isLoadingCatalog, onReady]);
    const isCatalogLoadFailed = !catalog.data && catalog.isError;
    const emptyStateKind = (
      completeCatalog ? songs.length === 0 : summary.data?.total === 0
    )
      ? 'firstRun'
      : 'noResults';

    const content = (() => {
      if (isLoadingCatalog) {
        return (
          <Stack align="center" style={{ paddingBlock: 'var(--ad-space-6)' }}>
            <StatusIndicator
              status="processing"
              label={tr('library.loading')}
            />
          </Stack>
        );
      }
      if (isCatalogLoadFailed) {
        return (
          <Card
            icon="database"
            title={tr('libraryLoadFailed')}
            material="glass"
            padding="lg"
            style={{
              width: 'min(100%, 40rem)',
              alignSelf: 'center',
              marginBlock: 'clamp(1rem, 4vh, 3rem)',
            }}
            actions={
              <Button
                icon="refresh"
                label={tr('retry')}
                onClick={() => void refreshSongs(client)}
              />
            }
          />
        );
      }
      if (visibleSongs.length > 0) {
        return (
          <>
            <VirtualGrid
              items={visibleSongs}
              scrollParent={pageRef}
              label={tr('library.songs')}
              hasNextPage={
                catalog.hasNextPage &&
                !catalog.isPlaceholderData &&
                !catalog.isError
              }
              loading={catalog.isFetching}
              loadMore={catalog.fetchNextPage}
              itemKey={itemKey}
              renderItem={renderSong}
            />
          </>
        );
      }

      return (
        <LibraryEmptyState
          kind={emptyStateKind}
          onOpenAudioSettings={() => openSettings('audio')}
          onOpenModels={() => openSettings('ai')}
        />
      );
    })();

    return (
      <>
        {addingToPlaylist && (
          <AddToPlaylistDialog
            songIds={[...selected]}
            onClose={() => setAddingToPlaylist(false)}
            onAdded={() => setSelected(new Set())}
          />
        )}
        {playlistsOpen && (
          <PlaylistDialog
            songs={songs}
            onClose={onClosePlaylists}
            disabled={
              localProcessing ||
              catalog.isFetching ||
              Boolean(
                store.online.room &&
                (!canControlRoom(store.online.room) ||
                  store.online.room.songId),
              )
            }
            onPlay={async (playlist, ordered) => {
              if (store.online.room) {
                await roomLibrary?.startPlaylist(
                  playlist.name,
                  ordered.map((song) => ({
                    songId: song.id,
                    revision: song.activeRevision,
                  })),
                );
              } else {
                const first = playlist.songIds[0];
                if (!first) return;
                store.startPlaylist(playlist.name, playlist.songIds);
                navigate(routes.karaoke(first));
              }
            }}
          />
        )}
        <RecordingsModal
          requestedSong={recordingsSong}
          onRequestHandled={clearRecordingsRequest}
          onAnalysisReady={setAnalysisRecordId}
        />
        {settingsSong && (
          <SongSettingsModal
            key={settingsSong.id}
            song={settingsSong}
            onClose={() => setSettingsSong(null)}
            onChange={setSettingsSong}
          />
        )}
        {returning &&
          pageRef.current &&
          createPortal(
            <div
              className="sceneCurtain"
              data-phase={reveal ? 'opening' : 'waiting'}
              aria-hidden
              style={{
                animationDirection: 'reverse',
                ...(reveal ? {} : { animation: 'none' }),
              }}
            />,
            pageRef.current,
          )}
        {selecting && (
          <SelectionToolbar
            selected={selected}
            songs={visibleSongs}
            disabled={catalog.isPlaceholderData}
            deleting={deleting}
            onSelect={setSelected}
            onDelete={() => void deleteSelected()}
            canDeleteSelected={localSongs.some(
              (song) =>
                selected.has(song.id) && !activeJobStatuses.has(song.status),
            )}
            onAddToPlaylist={() => setAddingToPlaylist(true)}
          />
        )}
        {content}
        {catalog.isFetchingNextPage && !!catalog.data && (
          <StatusIndicator status="processing" label={tr('library.loading')} />
        )}
        {((catalog.isError && !!catalog.data) || summary.isError) && (
          <Card
            title={tr('libraryLoadFailed')}
            actions={
              <Button
                icon="refresh"
                label={tr('retry')}
                onClick={() => void refreshSongs(client)}
              />
            }
          />
        )}
      </>
    );
  },
);

export default LibrarySongs;
