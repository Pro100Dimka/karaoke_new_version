import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { refreshSongs, type SongPage } from '../../../components/api-service';
import type { KaraokeTv } from '../../../features/karaoke/tv/karaokeTv';
import { roomSongPlayIntent } from '../../../features/room/roomSongIntent';
import { store } from '../../../providers/store';
import { routes } from '../../../shared/routes';
import { markPlayed } from './lastPlayed';
import type { useRoomLibrary } from './useRoomLibrary';

export const curtainMilliseconds = 400;

import { tr, useLocale } from '@neo-ui-kit/react';
import type { ProcessingJobDto, SongDto } from '../../../contracts/models';
import { version } from '../../../../package.json';
import { ask } from '../../../providers/dialog';
import { useNotify } from '../../../providers/notifications';
import { pythonClient as catalog } from '../../../services/pythonClient';
import { audioClient } from '../../../services/audioClient';
import { desktopClient } from '../../../services/desktopClient';
import { toAppError, errorstring } from '../../../shared/errors';
import { useGuardedAction } from './useGuardedAction';
import { confirmLyricsReset } from './confirmLyricsReset';

/** Confirmation shared by the card and song settings. */
export const useSongActions = (onDeleted?: () => void) => {
  const client = useQueryClient();
  const notify = useNotify();
  useLocale();
  const guarded = useGuardedAction();
  const [retrying, setRetrying] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const pending = useRef({ retry: false, report: false });

  const startProcessing = async (
    songId: string,
    mode: 'full' | 'lyrics',
    reset = false,
  ) => {
    if (pending.current.retry) return false;
    pending.current.retry = true;
    setRetrying(songId);
    try {
      if (reset) {
        if (!(await confirmLyricsReset(songId))) return false;
        // The reset is already committed even if subsequent job admission is refused.
        await refreshSongs(client);
        await client.invalidateQueries({
          queryKey: ['song-settings-document', songId],
        });
      }
      await catalog.processSong(songId, mode === 'lyrics' ? 'lyrics' : undefined);
      await Promise.all([
        refreshSongs(client),
        client.invalidateQueries({ queryKey: ['jobs'] }),
      ]);
      notify(tr('processingRetryStarted'), 'success');
      return true;
    } catch (failure) {
      const error = toAppError(failure);
      notify(
        error.code === 'MissingRequiredModels'
          ? tr('errorMissingModels')
          : `${tr(errorstring(error) ?? 'processingRetryFailed')}: ${error.message}`,
        'error',
      );
      return false;
    } finally {
      pending.current.retry = false;
      setRetrying(null);
    }
  };

  const retryProcessing = (songId: string, mode: 'full' | 'lyrics' = 'full') =>
    startProcessing(songId, mode);
  const resetLyricsAndReprocess = (songId: string) =>
    startProcessing(songId, 'lyrics', true);

  const reportProcessingError = async (
    songId: string,
    job?: ProcessingJobDto,
  ) => {
    if (pending.current.report) return;
    pending.current.report = true;
    setReporting(true);
    try {
      const [backend, audio] = await Promise.allSettled([
        catalog.diagnostics(),
        audioClient.diagnosticsDump(),
      ]);
      const id = await desktopClient.sendErrorReport(
        JSON.stringify(
          {
            version,
            generatedAt: new Date().toISOString(),
            songId,
            processingJob: job ?? null,
            backend:
              backend.status === 'fulfilled' ? backend.value : 'unavailable',
            audio: audio.status === 'fulfilled' ? audio.value : 'unavailable',
          },
          null,
          2,
        ),
      );
      notify(tr('processingReportSent', { id }), 'success');
    } catch {
      notify(tr('processingReportFailed'), 'error');
    } finally {
      pending.current.report = false;
      setReporting(false);
    }
  };

  const confirmDelete = async (song: SongDto) => {
    let count = 0;
    try {
      count = (await catalog.listRecordings(song.id)).length;
    } catch {
      // The count is informational; deletion is still confirmed explicitly.
    }
    const choice = await ask({
      title: tr('deleteSongTitle', { value: song.title }),
      body: tr('deleteSongBody', { count }),
      actions: [
        { id: 'cancel', label: tr('cancel') },
        { id: 'delete', label: tr('deleteSong'), appearance: 'primary' },
      ],
    });
    if (choice !== 'delete') return;
    await guarded(async () => {
      await catalog.deleteSong(song.id);
      await refreshSongs(client);
      onDeleted?.();
      notify(tr('songDeleted'), 'success');
    });
  };

  return {
    confirmDelete,
    retryProcessing,
    resetLyricsAndReprocess,
    retrying,
    reportProcessingError,
    reporting,
  };
};

export const useSongPlayback = ({
  roomLibrary,
  navigate,
  tv,
}: {
  roomLibrary: ReturnType<typeof useRoomLibrary>;
  navigate(path: string): void;
  tv?: KaraokeTv | null;
}) => {
  const client = useQueryClient();
  const notify = useNotify();
  const [launching, setLaunching] = useState(false);
  const launchTimer = useRef<number | null>(null);
  const processing = useRef(store.application.localProcessing);
  processing.current = store.application.localProcessing;
  useEffect(
    () => () => {
      if (launchTimer.current !== null)
        window.clearTimeout(launchTimer.current);
    },
    [],
  );
  // While someone sings on the TV a chosen song waits its turn there, or replaces the current one.
  const playOnTv = async (song: SongDto, rehearsal = false) => {
    if (!tv) return;
    const current = client
      .getQueriesData<InfiniteData<SongPage>>({ queryKey: ['songs'] })
      .flatMap(([, data]) => data?.pages.flatMap((page) => page.items) ?? [])
      .find((item) => item.id === tv.songId);
    if (song.id === tv.songId) return;
    const choice = await ask({
      title: tr('tvBusyTitle'),
      body: tr('tvBusyBody', {
        current: current?.title ?? '…',
        title: song.title,
      }),
      actions: [
        { id: 'cancel', label: tr('cancel') },
        { id: 'next', label: tr('tvQueueNext') },
        { id: 'now', label: tr('tvReplaceNow'), appearance: 'primary' },
      ],
    });
    if (processing.current || !['next', 'now'].includes(choice ?? '')) return;
    markPlayed(song.id);
    tv.play(
      { id: song.id, title: song.title, artist: song.artist, rehearsal },
      choice === 'next' ? 'next' : 'now',
    );
    if (choice === 'next')
      notify(tr('tvQueued', { title: song.title }), 'success');
  };

  const playSong = (song: SongDto, rehearsal = false) => {
    if (processing.current || launchTimer.current !== null) return;
    if (tv?.active) {
      void playOnTv(song, rehearsal);
      return;
    }
    const intent = roomSongPlayIntent(roomLibrary.room);
    if (intent === 'select-room') {
      void roomLibrary.selectSong(song);
      return;
    }
    if (intent === 'wait-for-host') {
      notify(tr('errorRoomPermission'), 'warning');
      return;
    }
    markPlayed(song.id);
    setLaunching(true);
    launchTimer.current = window.setTimeout(() => {
      launchTimer.current = null;
      if (processing.current) setLaunching(false);
      else {
        store.prepareKaraoke(song.id, rehearsal ? 'Rehearsal' : 'AutoStart');
        navigate(routes.karaoke(song.id));
      }
    }, curtainMilliseconds);
  };

  return { playSong, launching };
};
