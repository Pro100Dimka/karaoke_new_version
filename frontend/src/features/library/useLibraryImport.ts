import { useState, type DragEvent } from "react";
import { useNotify } from "../../app/NotificationsProvider";
import type { ImportMetadata, ImportOptions } from "../../contracts/clients";
import type { SongDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { desktopClient } from "../../services/desktopClient";
import { errorMessageKey, toAppError } from "../../shared/errors";
import { importOneByOne } from "./batchImport";
import { dragLeavesBoundary } from "./fileDrag";
import type { useGuardedAction } from "./useGuardedAction";

interface LibraryImportOptions {
  importSong: (path: string, metadata: ImportMetadata, options?: ImportOptions) => Promise<SongDto>;
  startProcessing: (song: SongDto) => Promise<unknown>;
  guarded: ReturnType<typeof useGuardedAction>;
  backendReady: boolean;
}

/** Adding songs: picked or dropped files are imported and queued for processing. */
export const useLibraryImport = ({
  importSong,
  startProcessing,
  guarded,
  backendReady,
}: LibraryImportOptions) => {
  const t = useText();
  const notify = useNotify();
  const [addOpen, setAddOpen] = useState(false);
  const [droppedPath, setDroppedPath] = useState("");
  const [dragging, setDragging] = useState(false);

  const importAndProcess = async (path: string, metadata: ImportMetadata, options?: ImportOptions) => {
    const song = await importSong(path, metadata, options);
    // A freshly added song is processed right away; a failure to start is reported by the action itself.
    void startProcessing(song);
  };

  const handleImport = async (path: string, metadata: ImportMetadata, options?: ImportOptions) => {
    await importAndProcess(path, metadata, options);
    notify(t("songImported"), "success");
  };

  // Several files picked or dropped at once are all added and queued for processing, one after another.
  const importMany = async (paths: readonly string[]) => {
    const { imported, failed } = await importOneByOne(paths, (path) => importAndProcess(path, {}));
    if (imported) notify(t("songsImported", { count: imported }), "success");
    if (failed.length) notify(t("songsImportFailed", { names: failed.join(", ") }), "error");
  };

  // The system file dialog already restricts the choice to supported audio extensions, so there is
  // nothing left for a confirmation step to add; picking files imports them immediately.
  const addSong = () =>
    guarded(async () => {
      const paths = await desktopClient.pickAudioFiles();
      if (paths.length > 1) {
        await importMany(paths);
        return;
      }
      const path = paths[0];
      if (!path) return;
      try {
        await handleImport(path, {});
      } catch (error) {
        notify(t(errorMessageKey(toAppError(error)) ?? "importFailed"), "error");
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
      void guarded(() => importMany(files.map((file) => desktopClient.pathForFile(file))));
      return;
    }
    setDroppedPath(desktopClient.pathForFile(first));
    setAddOpen(true);
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
    addDialog: { open: addOpen, initialPath: droppedPath, onClose: () => setAddOpen(false) },
  };
};
