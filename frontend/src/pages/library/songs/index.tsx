import { Button, Card, Stack, StatusIndicator, tr } from '@neo-ui-kit/react';
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
        try {
          page.scrollTop =
            Number(sessionStorage.getItem('adVoice.libraryScroll')) || 0;
        } catch {
          /* Keep the initial position. */
        }
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [pageRef, listReady]);
  useLayoutEffect(() => {
    const page = pageRef.current;
    return () => {
      try {
        if (page)
          sessionStorage.setItem(
            'adVoice.libraryScroll',
            String(page.scrollTop),
          );
      } catch {
        /* Scroll restoration is optional. */
      }
    };
  }, [pageRef]);
};

interface LibrarySongsProps {
  view: { query: string; filters: LibraryViewFilters };
  onOpenProcessing(songId: string): void;
  pageRef: RefObject<HTMLElement | null>;
  onPlay(song: SongDto, rehearsal?: boolean): void;
  songSelection: ReturnType<typeof useRoomLibrary>['songSelection'];
}

const LibrarySongs = observer(
  ({
    view,
    pageRef,
    onPlay,
    onOpenProcessing,
    songSelection,
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
    const toggleSelected = useCallback((id: string) => {
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    }, []);
    const selecting = selected.size > 0;
    const { catalog, summary, client, localSongs, songs, visibleSongs, completeCatalog } =
      useLibraryCatalog(query, viewFilters, selecting);

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
                    activeJobStatuses.has(song.status),
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
    const isCatalogLoadFailed = !catalog.data && catalog.isError;
    const emptyStateKind =
      (completeCatalog ? songs.length === 0 : summary.data?.total === 0)
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
            {selecting && (
              <SelectionToolbar
                selected={selected}
                songs={visibleSongs}
                disabled={catalog.isPlaceholderData}
                deleting={deleting}
                onSelect={setSelected}
                onDelete={() => void deleteSelected()}
              />
            )}
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
        {content}
        {catalog.isFetchingNextPage && !!catalog.data && (
          <StatusIndicator status="processing" label={tr('library.loading')} />
        )}
        {(catalog.isFetchNextPageError || summary.isError) && (
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
