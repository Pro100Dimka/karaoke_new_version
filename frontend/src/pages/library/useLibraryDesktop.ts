import { useEffect, useRef, useState, type DragEvent } from 'react';
import { libraryCommands } from '../../app/desktop/shellBus';
import { store } from '../../providers/store';
import { desktopClient } from '../../services/desktopClient';
import { useLibraryImport } from './modals/add-song/useLibraryImport';

/** Owns desktop commands and file drops; the page only attaches its handlers. */
export const useLibraryDesktop = (onInvitation: (code?: string) => void) => {
  const backendReady = store.application.services.python.kind === 'ready';
  const { addSong, importFiles } = useLibraryImport();
  const [dragging, setDragging] = useState(false);

  const handlers = useRef({ addSong, importFiles, onInvitation });
  handlers.current = { addSong, importFiles, onInvitation };

  useEffect(() => {
    if (!backendReady) return;
    return libraryCommands.subscribe((command) => {
      const current = handlers.current;
      switch (command.type) {
        case 'addSong':
          void current.addSong();
          break;
        case 'importFiles':
          void current.importFiles(command.paths);
          break;
        default:
          current.onInvitation(command.code);
      }
    });
  }, [backendReady]);

  const onDragOver = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (!dragging) setDragging(true);
  };

  const onDragLeave = (event: DragEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
      setDragging(false);
    }
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);

    const paths = Array.from(event.dataTransfer.files)
      .map((file) => desktopClient.pathForFile(file))
      .filter((path): path is string => Boolean(path));

    if (paths.length) libraryCommands.push({ type: 'importFiles', paths });
  };

  return {
    dragging,
    onDragOver,
    onDragLeave,
    onDrop,
  };
};
