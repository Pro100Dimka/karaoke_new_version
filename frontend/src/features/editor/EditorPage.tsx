import "./editor.css";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button, EmptyState, IconButton, PianoRoll, ProgressBar, ToggleButton, Toolbar, Typography, type PianoRollGesture } from "@ad-voice/ui";
import { routes } from "../../app/routes";
import { useText } from "../../i18n/useText";
import { EditorHeader } from "./EditorHeader";
import { EditorTransport } from "./EditorTransport";
import { documentEnd, maxPitch, minPitch, moveNotes, resizeNote, snapGridSeconds, snapTime, type EditorDocument } from "./editorModel";
import { useEditorSession } from "./useEditorSession";

const isEditingText = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);

const zoomSteps = [0.5, 0.75, 1, 1.5, 2, 3, 4] as const;
const maxZoom = zoomSteps[zoomSteps.length - 1] ?? 1;
const pitchMargin = 5;

/** The roll shows the melody's own range with a little air around it, never past what a note may reach. */
const pitchRange = (document: EditorDocument): [number, number] => {
  if (document.notes.length === 0) return [48, 84];
  const pitches = document.notes.map(note => note.pitch);
  return [Math.max(minPitch, Math.min(...pitches) - pitchMargin), Math.min(maxPitch, Math.max(...pitches) + pitchMargin)];
};

export const EditorPage = () => {
  const navigate = useNavigate();
  const { songId = "" } = useParams<{ songId: string }>();
  const t = useText();
  const session = useEditorSession(songId);
  const [zoom, setZoom] = useState(1);
  const [snap, setSnap] = useState(true);
  const [grid, setGrid] = useState(true);
  const [follow, setFollow] = useState(true);
  const { document, selection } = session;
  // A drag shows live previews; the document it started from makes the whole drag one undo step.
  const dragStart = useRef<EditorDocument | null>(null);
  const latest = useRef(document);
  latest.current = document;

  const leave = async () => {
    if (await session.resolveUnsaved()) navigate(routes.library);
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (isEditingText(event.target)) return;
      const command = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (command && key === "s") { event.preventDefault(); void session.save(); }
      else if (command && (key === "y" || (key === "z" && event.shiftKey))) { event.preventDefault(); session.redo(); }
      else if (command && key === "z") { event.preventDefault(); session.undo(); }
      else if (event.key === "Delete" && selection.size > 0) { event.preventDefault(); session.remove(selection); }
      else if (event.code === "Space" && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); void session.togglePlay(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [session, selection]);

  const back = <Button icon="back" onClick={() => navigate(routes.library)}>{t("library")}</Button>;
  if (session.load.kind === "loading" || (session.load.kind === "ready" && !document)) {
    return <main className="editorPage editorState" aria-live="polite"><ProgressBar indeterminate label={t("loadingEditor")} /></main>;
  }
  if (session.load.kind === "failed" || session.load.kind === "invalid") {
    const message = session.load.kind === "invalid" && session.load.compatibility === "TooNew" ? t("errorProjectTooNew")
      : session.load.kind === "invalid" && session.load.compatibility !== "NotReady" ? t("errorProjectUpgrade") : t("editorLoadFailed");
    return <main className="editorPage editorState" role="alert"><EmptyState icon="warning" title={message} action={back} /></main>;
  }
  if (!document || session.load.kind !== "ready") return null;

  const song = session.load.song;
  const duration = documentEnd(document, song.durationSeconds);
  const [lowest, highest] = pitchRange(document);
  const zoomIndex = zoomSteps.findIndex(step => step >= zoom);

  const drag = (gesture: PianoRollGesture) => {
    const before = dragStart.current ?? document;
    dragStart.current = before;
    if (gesture.kind === "move") {
      session.replacePresent(moveNotes(before, new Set(gesture.ids), gesture.pitch, snapTime(gesture.seconds, snap)));
      return;
    }
    const note = before.notes.find(item => item.id === gesture.id);
    if (!note) return;
    const origin = gesture.edge === "start" ? note.start : note.end;
    session.replacePresent(resizeNote(before, gesture.id, gesture.edge, snapTime(origin + gesture.seconds, snap)));
  };
  const dragEnd = () => {
    const before = dragStart.current;
    dragStart.current = null;
    if (before && latest.current && latest.current !== before) session.commit(before, latest.current);
  };

  return (
    <main className="editorPage">
      <EditorHeader title={`${song.title} — ${song.artist}`} revision={document.revision} dirty={session.dirty} saving={session.saving}
        canUndo={session.canUndo} canRedo={session.canRedo} onBack={() => void leave()} onUndo={session.undo} onRedo={session.redo}
        onSave={() => void session.save()} />
      <EditorTransport songId={song.id} revision={song.activeRevision} playing={session.playing} position={session.position}
        duration={duration} audioReady={session.audioReady} onTogglePlay={() => void session.togglePlay()} onSeek={value => void session.seek(value)} />

      <Toolbar className="editorTools" aria-label={t("editorTools")}>
        <ToggleButton size="sm" icon="grid" label={t("editorGrid")} checked={grid} onValueChange={setGrid} />
        <ToggleButton size="sm" icon="target" label={t("editorSnap")} checked={snap} onValueChange={setSnap} />
        <ToggleButton size="sm" icon="motion" label={t("editorFollow")} checked={follow} onValueChange={setFollow} />
        <span className="editorZoom">
          <IconButton size="sm" icon="minus" label={t("zoomOut")} disabled={zoomIndex <= 0}
            onClick={() => setZoom(zoomSteps[Math.max(0, zoomIndex - 1)] ?? 1)} />
          <Typography variant="mono" aria-label={t("zoom")}>{Math.round(zoom * 100)}%</Typography>
          <IconButton size="sm" icon="plus" label={t("zoomIn")} disabled={zoom >= maxZoom}
            onClick={() => setZoom(zoomSteps.find(step => step > zoom) ?? zoom)} />
          <IconButton size="sm" icon="fit" label={t("editorZoomReset")} disabled={zoom === 1} onClick={() => setZoom(1)} />
        </span>
        <IconButton size="sm" icon="trash" label={t("editorDeleteNotes")} disabled={selection.size === 0}
          onClick={() => session.remove(selection)} />
        <Typography className="editorHint" variant="caption" tone="muted" truncate>{t("editorHint")}</Typography>
      </Toolbar>

      <PianoRoll className="editorRoll" label={t("melodyEditor")} notes={document.notes} words={document.words} duration={duration}
        position={session.position} selected={selection} zoom={zoom} onZoomChange={setZoom} minPitch={lowest} maxPitch={highest}
        follow={follow && session.playing} grid={grid} nudgeSeconds={snapGridSeconds} onSelect={session.select}
        onSelectArea={(ids, additive) => session.setSelection(current => new Set([...(additive ? current : []), ...ids]))}
        onSeek={value => void session.seek(value)} onNoteDrag={drag} onNoteDragEnd={dragEnd}
        onNudge={(id, pitch, seconds) => session.move(new Set([id]), pitch, seconds)} />
    </main>
  );
};
