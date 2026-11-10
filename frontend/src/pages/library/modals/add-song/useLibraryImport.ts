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
    // A freshly added song is processed right away; a failure to start is reported by the action itself.
    await guarded(async () => {
      if (song.status !== 'not-processed') return;
      await pythonClient.processSong(song.id);
      await refreshSongs(client);
      notify(tr('processingStarted'), 'info');
    });
  };

  const handleImport = async (
    path: string,
    metadata: ImportMetadata,
    options?: ImportOptions,
  ) => {
    await importAndProcess(path, metadata, options);
    notify(tr('songImported'), 'success');
  };

  // Show the whole batch immediately; import and queue processing one file at a time.
  const importMany = async (paths: readonly string[]) => {
    let imported = 0;
    const failed: string[] = [];
    const pending = paths.flatMap((path) => {
      const name = path.split(/[\\/]/).pop() ?? path;
      const dot = name.lastIndexOf('.');
      if (!isSupportedAudio(dot < 0 ? '' : name.slice(dot + 1))) {
        failed.push(name);
        return [];
      }
      return [{ path, name, placeholderId: queueSongImport(client, path) }];
    });
    for (const { path, name, placeholderId } of pending) {
      try {
        await importAndProcess(path, {}, undefined, placeholderId);
        imported += 1;
      } catch {
        failed.push(name);
      }
    }
    if (imported) notify(tr('songsImported', { count: imported }), 'success');
    if (failed.length)
      notify(tr('songsImportFailed', { names: failed.join(', ') }), 'error');
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
        notify(tr(errorstring(toAppError(error)) ?? 'importFailed'), 'error');
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
