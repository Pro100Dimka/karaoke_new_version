import { object, string, picklist, safeParse } from "valibot";
import type { LibraryViewFilters } from "./hero/search-field";
import { observer } from "mobx-react-lite";
import { store } from "../../providers/store";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { useRouter, Stack, tr, useLocale } from "@neo-ui-kit/react";

import { ru } from "../../i18n/messages.ru";

import { RoomModal } from "../../features/room/RoomModal";
import { useKaraokeTv } from "../../features/karaoke/tv/karaokeTv";
import { AddSongModal } from "./modals/add-song/index";
import "./library.css";
import { LibraryActions } from "./hero/actions";
import { LibraryHeader } from "./hero/index";
import { ProcessingModal } from "./modals/processing/index";
import { useLibraryImport } from "./modals/add-song/useLibraryImport";
import { desktopClient } from "../../services/desktopClient";
import { libraryCommands } from "../../app/desktop/shellBus";
import { useRoomLibrary } from "./songs/useRoomLibrary";
import { useSongPlayback } from "./songs/useSongActions";
import LibrarySongs from "./songs";


const viewSchema = object({
  query: string(),
  filters: object({
    status: picklist(["all", "not-processed", "queued", "processing", "ready", "failed", "importing", "invalid"]),
    language: picklist(["all", "Auto", "Ukrainian", "Russian", "English"]),
    duration: picklist(["all", "short", "medium", "long"]),
    artwork: picklist(["all", "with", "without"]),
  }),
});

export const LibraryPage = observer(() => {
  const pageRef = useRef<HTMLElement>(null);
  const [view, setView] = useState<{ query: string; filters: LibraryViewFilters }>(() => {
    try {
      const result = safeParse(viewSchema, JSON.parse(sessionStorage.getItem("adVoice.libraryView") ?? "null"));
      if (result.success) return result.output;
    } catch { /* Missing storage must not prevent opening the library. */ }
    return { query: "", filters: { status: "all", language: "all", duration: "all", artwork: "all" } };
  });
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => () => {
    try { sessionStorage.setItem("adVoice.libraryView", JSON.stringify(viewRef.current)); } catch { /* The local view remains usable. */ }
  }, []);
  const setQuery = useCallback((query: string) => setView(current => current.query === query ? current : { ...current, query }), []);
  const setViewFilters = useCallback((update: (filters: LibraryViewFilters) => LibraryViewFilters) =>
    setView(current => { const filters = update(current.filters); return filters === current.filters ? current : { ...current, filters }; }), []);
  const { navigate } = useRouter();
  const tv = useKaraokeTv();
  useLocale();
  const { python } = store.application.services;

  const [processing, setProcessing] = useState<{ focusSongId?: string } | null>(null);
  const openProcessing = useCallback((focusSongId?: string) => setProcessing({ focusSongId }), []);
  const [roomOpen, setRoomOpen] = useState(false);
  const [invitationCode, setInvitationCode] = useState<string>();
  const roomLibrary = useRoomLibrary({
    setQuery, setViewFilters,
  });
  const { room } = roomLibrary;

  const { playSong, launching } = useSongPlayback({ roomLibrary, navigate, tv });
  const songImport = useLibraryImport();
  const [dragging, setDragging] = useState(false);
  const [droppedPath, setDroppedPath] = useState<string | null>(null);
  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer.files);
    const first = files[0];
    if (!first || python.kind !== "ready") return;
    if (files.length > 1) {
      void songImport.importFiles(files.map(file => desktopClient.pathForFile(file)));
      return;
    }
    setDroppedPath(desktopClient.pathForFile(first));
  };
  // The desktop's requests (jump list, invitation links, files opened with the app) are taken once
  // the backend can import; until then they wait in the queue.
  const importRef = useRef(songImport);
  importRef.current = songImport;
  const backendReady = python.kind === "ready";
  useEffect(() => {
    if (!backendReady) return;
    return libraryCommands.subscribe((command) => {
      if (command.type === "addSong") void importRef.current.addSong();
      else if (command.type === "importFiles")
        void importRef.current.importFiles(command.paths);
      else {
        setInvitationCode(command.code);
        setRoomOpen(true);
      }
    });
  }, [backendReady]);


  return (
    <Stack as="main" ref={pageRef} style={{ height: "100%", minHeight: 0, overflowX: "hidden", overflowY: "auto" }} onDragOver={event => { event.preventDefault(); setDragging(true); }}
      onDragLeave={event => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) setDragging(false);
      }}
      onDrop={handleDrop}>
      {dragging && (
        <div className="dropOverlay">{tr(ru.dropToImport)}</div>
      )}
      <Stack as="section" gap={4}
        style={{ width: '90%', marginInline: 'auto', paddingBlock: '5vh', flexShrink: 0, position: 'relative', zIndex: 1 }}>
        <LibraryHeader />
        <LibraryActions view={view} onQueryChange={setQuery} onFiltersChange={filters => setViewFilters(() => filters)}
          onOpenProcessing={openProcessing}
          roomRole={room?.role}
          collaborativeControl={room?.collaborativeControl}
          onCollaborativeControlChange={roomLibrary.setCollaborativeControl}
          onOpenRoom={() => setRoomOpen(true)}
          onViewChange={roomLibrary.publishView}
        />
        <LibrarySongs view={view} pageRef={pageRef} onPlay={playSong} onOpenProcessing={openProcessing} songSelection={roomLibrary.songSelection} />
      </Stack>
      <AddSongModal open={droppedPath !== null} initialPath={droppedPath ?? ""}
        onClose={() => setDroppedPath(null)} />
      <RoomModal
        open={roomOpen}
        invitationCode={invitationCode}
        onClose={() => {
          setRoomOpen(false);
          setInvitationCode(undefined);
        }}
      />
      <ProcessingModal open={processing !== null} focusSongId={processing?.focusSongId}
        onClose={() => setProcessing(null)} onPlay={playSong} />
      {launching && <div className="sceneCurtain" aria-hidden />}
    </Stack>
  );
});

export default LibraryPage;
