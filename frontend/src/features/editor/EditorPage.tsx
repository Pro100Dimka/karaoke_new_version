import "./editor.css";
import { Spinner } from "../../shared/ui/Spinner";
import { Button, Typography } from "../../theme/ui";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { routes } from "../../app/routes";
import { useText } from "../../i18n/useText";
import { EditorHeader } from "./EditorHeader";
import { EditorSurface } from "./EditorSurface";
import { EditorTransport } from "./EditorTransport";
import { canMerge, documentEnd } from "./editorModel";
import { useEditorSession } from "./useEditorSession";

const isEditingText = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);

export const EditorPage = () => {
  const navigate = useNavigate();
  const { songId = "" } = useParams<{ songId: string }>();
  const t = useText();
  const session = useEditorSession(songId);
  const [zoom, setZoom] = useState(1);
  const [follow, setFollow] = useState(true);
  const [snap, setSnap] = useState(true);
  const { document, selection } = session;

  const leave = async () => {
    if (await session.resolveUnsaved()) navigate(routes.library);
  };

  // Ctrl+S / Ctrl+Z / Ctrl+Y / Delete / Space, except while typing in a field.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (isEditingText(event.target)) return;
      const command = event.ctrlKey || event.metaKey;
      if (command && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void session.save();
      } else if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        session.undo();
      } else if (command && event.key.toLowerCase() === "y") {
        event.preventDefault();
        session.redo();
      } else if (event.key === "Delete" && selection.size > 0) {
        event.preventDefault();
        session.remove(selection);
      } else if (event.code === "Space" && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault();
        void session.togglePlay();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [session, selection]);

  const back = (
    <Button startIcon={<ArrowLeft size={16} />} onClick={() => navigate(routes.library)}>
      {t("library")}
    </Button>
  );

  if (session.load.kind === "loading" || (session.load.kind === "ready" && !document)) {
    return (
      <main className="editorPage editorState" aria-live="polite">
        <Spinner label={t("loadingEditor")} />
      </main>
    );
  }

  if (session.load.kind === "failed" || session.load.kind === "invalid") {
    const message =
      session.load.kind === "invalid" && session.load.compatibility === "TooNew"
        ? t("errorProjectTooNew")
        : session.load.kind === "invalid" && session.load.compatibility !== "NotReady"
          ? t("errorProjectUpgrade")
          : t("editorLoadFailed");
    return (
      <main className="editorPage editorState" role="alert">
        <AlertTriangle aria-hidden size={36} />
        <p>{message}</p>
        {back}
      </main>
    );
  }

  if (!document || session.load.kind !== "ready") return null;
  const song = session.load.song;
  const duration = documentEnd(document, song.durationSeconds);
  const firstSelected = document.notes.find(note => selection.has(note.id));

  return (
    <main className="editorPage">
      <EditorHeader
        title={`${song.artist} — ${song.title}`}
        revision={document.revision}
        dirty={session.dirty}
        saving={session.saving}
        canUndo={session.canUndo}
        canRedo={session.canRedo}
        hasSelection={selection.size > 0}
        canMerge={canMerge(document, selection)}
        onBack={() => void leave()}
        onUndo={session.undo}
        onRedo={session.redo}
        onRestore={() => void session.restore()}
        onSave={() => void session.save()}
        onDelete={() => session.remove(selection)}
        onMerge={() => session.merge(selection)}
        onLocate={() => firstSelected && void session.seek(firstSelected.start)}
        onAlignStart={() => session.align(selection, "start", session.position)}
        onAlignEnd={() => session.align(selection, "end", session.position)}
      />
      <EditorTransport
        playing={session.playing}
        position={session.position}
        duration={duration}
        zoom={zoom}
        follow={follow}
        snap={snap}
        audioReady={session.audioReady}
        onTogglePlay={() => void session.togglePlay()}
        onPositionChange={value => void session.seek(value)}
        onZoomChange={setZoom}
        onFollowChange={setFollow}
        onSnapChange={setSnap}
      />
      <EditorSurface
        document={document}
        selection={selection}
        zoom={zoom}
        durationSeconds={duration}
        position={session.position}
        follow={follow}
        snap={snap}
        playing={session.playing}
        onSelect={session.select}
        onSeek={value => void session.seek(value)}
        onPreview={session.replacePresent}
        onCommit={session.commit}
        onNudge={(id, pitch, seconds) => session.move(new Set([id]), pitch, seconds)}
      />
      <footer className="editorHint">
        <Typography as="span" variant="caption" tone="muted">{t("editorHint")}</Typography>
      </footer>
    </main>
  );
};
