import { useQueryClient } from "@tanstack/react-query";
import { importSong, refreshSongs } from "../../../../api/api-service";
import { pythonClient } from "../../../../services/pythonClient";
import { tr, useLocale } from "@neo-ui-kit/react";
import { desktopClient as libraryFiles } from "../../../../services/desktopClient";
import { useNotify } from "../../../../providers/notifications";
import type { ImportMetadata, ImportOptions } from "../../../../contracts/clients";
import { ru } from "../../../../i18n/messages.ru";
import { errorMessageKey, toAppError } from "../../../../shared/errors";
import { isSupportedAudio } from "./importModel";
import { useGuardedAction } from "../../songs/useGuardedAction";

/** Picked and dropped files share import progress in the query cache. */
export const useLibraryImport = () => {
  const client = useQueryClient();
  const guarded = useGuardedAction();
  useLocale();
  const notify = useNotify();

  const importAndProcess = async (path: string, metadata: ImportMetadata, options?: ImportOptions) => {
    const song = await importSong(client, path, metadata, options);
    // A freshly added song is processed right away; a failure to start is reported by the action itself.
    void guarded(async () => {
      if (song.status !== "not-processed") return;
      await pythonClient.processSong(song.id);
      await refreshSongs(client);
      notify(tr(ru.processingStarted), "info");
    });
  };

  const handleImport = async (path: string, metadata: ImportMetadata, options?: ImportOptions) => {
    await importAndProcess(path, metadata, options);
    notify(tr(ru.songImported), "success");
  };

  // Several files picked or dropped at once are all added and queued for processing, one after another.
  const importMany = async (paths: readonly string[]) => {
    let imported = 0;
    const failed: string[] = [];
    for (const path of paths) {
      const name = path.split(/[\\/]/).pop() ?? path;
      const dot = name.lastIndexOf(".");
      if (!isSupportedAudio(dot < 0 ? "" : name.slice(dot + 1))) {
        failed.push(name);
        continue;
      }
      try {
        await importAndProcess(path, {});
        imported += 1;
      } catch { failed.push(name); }
    }
    if (imported) notify(tr(ru.songsImported, { count: imported }), "success");
    if (failed.length) notify(tr(ru.songsImportFailed, { names: failed.join(", ") }), "error");
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
        notify(tr(ru[errorMessageKey(toAppError(error)) ?? "importFailed"]), "error");
      }
    });

  return {
    addSong,
    handleImport,
    /** Files opened with the app ("Open with" in Explorer) are added like several dropped files. */
    importFiles: (paths: readonly string[]) => (paths.length ? guarded(() => importMany(paths)) : undefined),
  };
};
