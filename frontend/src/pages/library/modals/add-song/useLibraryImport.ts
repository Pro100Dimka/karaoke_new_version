import { tr, useLocale } from '@neo-ui-kit/react';
import { useQueryClient } from '@tanstack/react-query';
import {
  importSong,
  queueSongImport,
  refreshSongs,
} from '../../../../components/api-service';
import type {
  ImportMetadata,
  ImportOptions,
} from '../../../../contracts/clients';
import { useNotify } from '../../../../providers/notifications';
import { desktopClient as libraryFiles } from '../../../../services/desktopClient';
import { pythonClient } from '../../../../services/pythonClient';
import { errorstring, toAppError } from '../../../../shared/errors';
import { useGuardedAction } from '../../songs/useGuardedAction';
import { isSupportedAudio } from './importModel';

const importErrorText = (cause: unknown, fallback = 'importFailed'): string => {
  const error = toAppError(cause);
  const key = errorstring(error);
  const detail = !key && error.source === 'python' && error.message;
  return `${tr(key ?? fallback)}${detail ? `: ${detail}` : ''}`;
};

/** Picked and dropped files share import progress in the query cache. */
export const useLibraryImport = () => {
  const client = useQueryClient();
  const guarded = useGuardedAction();
  useLocale();
  const notify = useNotify();

  const importAndProcess = async (
    path: string,
    metadata: ImportMetadata,
    options?: ImportOptions,
    placeholderId?: string,
  ) => {
    const song = await importSong(
      client,
      path,
      metadata,
      options,
      placeholderId,
    );
    if (song.status !== 'not-processed') return;
    try {
      await pythonClient.processSong(song.id);
      await refreshSongs(client);
    } catch (error) {
      return importErrorText(error, 'actionFailed');
    }
  };

  const handleImport = async (
    path: string,
    metadata: ImportMetadata,
    options?: ImportOptions,
  ) => {
    const processingError = await importAndProcess(path, metadata, options);
    if (processingError)
      notify(`${tr('songImported')}\n${processingError}`, 'warning');
    else notify(tr('songImported'), 'success');
  };

  // Show the whole batch immediately; import and queue processing one file at a time.
  const importMany = async (paths: readonly string[]) => {
    let imported = 0;
    const failed: string[] = [];
    const processingErrors: string[] = [];
    const pending = paths.flatMap((path) => {
      const name = path.split(/[\\/]/).pop() ?? path;
      const dot = name.lastIndexOf('.');
      if (!isSupportedAudio(dot < 0 ? '' : name.slice(dot + 1))) {
        failed.push(`${name}: ${tr('errorUnsupportedMedia')}`);
        return [];
      }
      return [{ path, name, placeholderId: queueSongImport(client, path) }];
    });
    for (const { path, name, placeholderId } of pending) {
      try {
        const processingError = await importAndProcess(
          path,
          {},
          undefined,
          placeholderId,
        );
        if (processingError)
          processingErrors.push(`${name}: ${processingError}`);
        imported += 1;
      } catch (error) {
        failed.push(`${name}: ${importErrorText(error)}`);
      }
    }
    const success = imported ? tr('songsImported', { count: imported }) : '';
    const failure = failed.length
      ? tr('songsImportFailed', { names: failed.join(', ') })
      : '';
    const message = [success, failure, ...processingErrors]
      .filter(Boolean)
      .join('\n');
    if (message) {
      const tone = failure || processingErrors.length ? 'warning' : 'success';
      notify(message, imported ? tone : 'error');
    }
  };

  // The system file dialog already restricts the choice to supported audio extensions, so there is
  // nothing left for a confirmation step to add; picking files imports them immediately.
  const addSong = () =>
    guarded(async () => {
      const paths = await libraryFiles.pickAudioFiles();
      if (paths.length > 1) {
        await importMany(paths);
        return;
      }
      const path = paths[0];
      if (!path) return;
      try {
        await handleImport(path, {});
      } catch (error) {
        notify(importErrorText(error), 'error');
      }
    });

  return {
    addSong,
    handleImport,
    /** Files opened with the app ("Open with" in Explorer) are added like several dropped files. */
    importFiles: (paths: readonly string[]) =>
      paths.length ? guarded(() => importMany(paths)) : undefined,
  };
};
