import { createContext, useContext, type ReactNode } from "react";
import type {
  LibraryCatalogPort, LibraryFilesPort, LibraryJobEventsPort, RecordingPreviewPort,
} from "../application/library/LibraryPorts";
import { backendEventsAvailable, refreshOnJobChanges } from "../services/backendEvents";
import { audioClient } from "../services/audioClient";
import { desktopClient } from "../services/desktopClient";
import { pythonClient } from "../services/pythonClient";

type LibraryPorts = {
  catalog: LibraryCatalogPort;
  files: LibraryFilesPort;
  preview: RecordingPreviewPort;
  events: LibraryJobEventsPort;
};
const implementations: LibraryPorts = {
  catalog: pythonClient,
  files: desktopClient,
  preview: audioClient,
  events: { available: backendEventsAvailable, subscribe: refreshOnJobChanges },
};
const LibraryContext = createContext<LibraryPorts | null>(null);

export const LibraryProvider = ({ children }: { children: ReactNode }) =>
  <LibraryContext.Provider value={implementations}>{children}</LibraryContext.Provider>;

const useLibraryPorts = (): LibraryPorts => {
  const ports = useContext(LibraryContext);
  if (!ports) throw new Error("LibraryProvider is missing");
  return ports;
};

export const useLibraryCatalog = (): LibraryCatalogPort => useLibraryPorts().catalog;
export const useLibraryFiles = (): LibraryFilesPort => useLibraryPorts().files;
export const useRecordingPreview = (): RecordingPreviewPort => useLibraryPorts().preview;
export const useLibraryJobEvents = (): LibraryJobEventsPort => useLibraryPorts().events;
