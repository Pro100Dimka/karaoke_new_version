import { useQueryClient } from "@tanstack/react-query";
import { runInAction } from "mobx";
import { store } from "../../../../providers/store";
import { importSong, refreshSongs } from "../../../../api/api-service";
import { pythonClient } from "../../../../services/pythonClient";
import { tr, useLocale } from "@neo-ui-kit/react";
import { desktopClient as libraryFiles } from "../../../../services/desktopClient";
import { useState, type DragEvent } from "react";
import { useNotify } from "../../../../providers/notifications";
import type { ImportMetadata, ImportOptions } from "../../../../contracts/clients";
import { ru } from "../../../../i18n/messages.ru";
import { errorMessageKey, toAppError } from "../../../../shared/errors";
import { importOneByOne } from "./batchImport";
import { dragLeavesBoundary } from "./fileDrag";
import { useGuardedAction } from "../../songs/useGuardedAction";

/** Picked and dropped files share import progress in the query cache. */
export const useLibraryImport = () => {
  const client = useQueryClient();
  const guarded = useGuardedAction();
  const backendReady = store.application.services.python.kind === "ready";
  useLocale();
  const notify = useNotify();
  const [dragging, setDragging] = useState(false);

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
    const { imported, failed } = await importOneByOne(paths, (path) => importAndProcess(path, {}));
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

  /** One dropped file opens the add dialog; several are imported straight away. */
  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer.files);
    const [first] = files;
    if (!first || !backendReady) return;
    if (files.length > 1) {
      void guarded(() => importMany(files.map((file) => libraryFiles.pathForFile(file))));
      return;
    }
    runInAction(() => {
      store.libraryDialogs.droppedPath = libraryFiles.pathForFile(first);
      store.libraryDialogs.addOpen = true;
    });
  };

  const dropTarget = {
    onDragOver: (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      setDragging(true);
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (dragLeavesBoundary(event.currentTarget, event.relatedTarget)) setDragging(false);
    },
    onDrop: handleDrop,
  };

  return {
    dragging,
    dropTarget,
    addSong,
    handleImport,
    /** Files opened with the app ("Open with" in Explorer) are added like several dropped files. */
    importFiles: (paths: readonly string[]) => (paths.length ? guarded(() => importMany(paths)) : undefined),
  };
};
