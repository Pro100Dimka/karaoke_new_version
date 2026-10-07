import "./editor.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Button,
  EmptyState,
  IconButton,
  PianoRoll,
  ProgressBar,
  ToggleButton,
  Toolbar,
  Typography,
  type PianoRollGesture,
} from "@ad-voice/ui";
import { routes } from "../../shared/routes";
import type { ProjectCompatibility } from "../../contracts/clients";
import type { MessageKey } from "../../i18n/messages";
import { useText } from "../../i18n/useText";
import { EditorHeader } from "./EditorHeader";
import { EditorTransport } from "./EditorTransport";
import {
  documentEnd,
  maxPitch,
  minPitch,
  moveNotes,
  resizeNote,
  snapGridSeconds,
  snapTime,
  type EditorDocument,
} from "./editorModel";
import { useEditorSession } from "./useEditorSession";

const isEditingText = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);

const zoomSteps = [0.5, 0.75, 1, 1.5, 2, 3, 4] as const;
const maxZoom = zoomSteps[zoomSteps.length - 1] ?? 1;
// At 1 a typical word gets 20–40 px and its label is cut to "l…"; at 2 the words read whole.
const openingZoom = 2;
const pitchMargin = 5;
const invalidLoadMessage = {
  NotReady: "editorLoadFailed",
  TooNew: "errorProjectTooNew",
  Upgradeable: "errorProjectUpgrade",
  Unsupported: "errorProjectUpgrade",
  Invalid: "errorProjectUpgrade",
} satisfies Record<Exclude<ProjectCompatibility, "Current"> | "NotReady", MessageKey>;

/** The roll shows the melody's own range with a little air around it, never past what a note may reach. */
const pitchRange = (document: EditorDocument): [number, number] => {
  if (document.notes.length === 0) return [48, 84];
  const pitches = document.notes.map((note) => note.pitch);
  return [
    Math.max(minPitch, Math.min(...pitches) - pitchMargin),
    Math.min(maxPitch, Math.max(...pitches) + pitchMargin),
  ];
};

/** The pitch half of the melody's notes lie below: where most of the singing is. */
const medianPitch = (document: EditorDocument): number => {
  const pitches = document.notes.map((note) => note.pitch).sort((a, b) => a - b);
  return pitches[Math.floor(pitches.length / 2)] ?? 60;
};

export const EditorPage = () => {
  const navigate = useNavigate();
  const { songId = "" } = useParams<{ songId: string }>();
  const t = useText();
  const session = useEditorSession(songId);
  const [zoom, setZoom] = useState(openingZoom);
  const [snap, setSnap] = useState(true);
  const [grid, setGrid] = useState(true);
  const [follow, setFollow] = useState(true);
  const { document, selection } = session;
  const range = useMemo(() => document ? pitchRange(document) : [48, 84], [document]);
  const duration = useMemo(() => document ? documentEnd(document,
    session.load.kind === "ready" ? session.load.song.durationSeconds : 0) : 0,
    [document, session.load]);
  const keyboard = useRef({ session, selection });
  keyboard.current = { session, selection };
  // A drag shows live previews; the document it started from makes the whole drag one undo step.
  const dragStart = useRef<EditorDocument | null>(null);
  const latest = useRef(document);
  latest.current = document;
  const page = useRef<HTMLElement>(null);
  const centeredSong = useRef("");

  // The roll opens on the melody itself, not on its highest note: one stray high note used to
  // leave the visible part empty and the singing far below it.
  useEffect(() => {
    if (!document || document.notes.length === 0 || centeredSong.current === songId) return;
    const roll = page.current?.querySelector<HTMLElement>(".ad-piano-roll-scroll");
    if (!roll || roll.scrollHeight <= roll.clientHeight) return;
    centeredSong.current = songId;
    const [lowest, highest] = pitchRange(document);
    const rowHeight = roll.scrollHeight / (highest - lowest + 1);
    roll.scrollTop = (highest - medianPitch(document) + 0.5) * rowHeight - roll.clientHeight / 2;
  }, [document, songId]);

  const leave = async () => {
    if (await session.resolveUnsaved()) navigate(routes.library);
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const { session, selection } = keyboard.current;
      if (isEditingText(event.target)) return;
      const command = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (command && key === "s") {
        event.preventDefault();
        void session.save();
      } else if (command && (key === "y" || (key === "z" && event.shiftKey))) {
        event.preventDefault();
        session.redo();
      } else if (command && key === "z") {
        event.preventDefault();
        session.undo();
      } else if (event.key === "Delete" && selection.size > 0) {
        event.preventDefault();
        session.remove(selection);
      } else if (
        event.code === "Space" &&
        !(event.target instanceof HTMLButtonElement)
      ) {
        event.preventDefault();
        void session.togglePlay();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const back = (
    <Button icon="back" onClick={() => navigate(routes.library)}>
      {t("library")}
    </Button>
  );
  if (
    session.load.kind === "loading" ||
    (session.load.kind === "ready" && !document)
  ) {
    return (
      <main className="editorPage editorState" aria-live="polite">
        <ProgressBar indeterminate label={t("loadingEditor")} />
      </main>
    );
  }
  if (session.load.kind === "failed" || session.load.kind === "invalid") {
    const message = t(session.load.kind === "invalid"
      ? invalidLoadMessage[session.load.compatibility]
      : "editorLoadFailed");
    return (
      <main className="editorPage editorState" role="alert">
        <EmptyState icon="warning" title={message} action={back} />
      </main>
    );
  }
  if (!document || session.load.kind !== "ready") return null;

  const song = session.load.song;
  const [lowest, highest] = range;
  const zoomIndex = zoomSteps.findIndex((step) => step >= zoom);
  const toggles = [
    { icon: "grid", label: "editorGrid", checked: grid, onValueChange: setGrid },
    { icon: "target", label: "editorSnap", checked: snap, onValueChange: setSnap },
    { icon: "motion", label: "editorFollow", checked: follow, onValueChange: setFollow },
  ] as const;

  const drag = (gesture: PianoRollGesture) => {
    const before = dragStart.current ?? document;
    dragStart.current = before;
    if (gesture.kind === "move") {
      session.replacePresent(
        moveNotes(
          before,
          new Set(gesture.ids),
          gesture.pitch,
          snapTime(gesture.seconds, snap),
        ),
      );
      return;
    }
    const note = before.notes.find((item) => item.id === gesture.id);
    if (!note) return;
    const origin = gesture.edge === "start" ? note.start : note.end;
    session.replacePresent(
      resizeNote(
        before,
        gesture.id,
        gesture.edge,
        snapTime(origin + gesture.seconds, snap),
      ),
    );
  };
  const dragEnd = () => {
    const before = dragStart.current;
    dragStart.current = null;
    if (before && latest.current && latest.current !== before)
      session.commit(before, latest.current);
  };

  return (
    <main className="editorPage" ref={page}>
      <EditorHeader
        title={`${song.title} — ${song.artist}`}
        revision={document.revision}
        dirty={session.dirty}
        saving={session.saving}
        canUndo={session.canUndo}
        canRedo={session.canRedo}
        onBack={() => void leave()}
        onUndo={session.undo}
        onRedo={session.redo}
        onSave={() => void session.save()}
      />
      <EditorTransport
        songId={song.id}
        revision={song.activeRevision}
        playing={session.playing}
        position={session.position}
        duration={duration}
        audioReady={session.audioReady}
        onTogglePlay={() => void session.togglePlay()}
        onSeek={(value) => void session.seek(value)}
      />

      <Toolbar className="editorTools" aria-label={t("editorTools")}>
        {toggles.map(({ icon, label, checked, onValueChange }) => (
          <ToggleButton
            key={icon}
            size="sm"
            icon={icon}
            label={t(label)}
            checked={checked}
            onValueChange={onValueChange}
          />
        ))}
        <span className="editorZoom">
          <IconButton
            size="sm"
            icon="minus"
            label={t("zoomOut")}
            disabled={zoomIndex <= 0}
            onClick={() => setZoom(zoomSteps[Math.max(0, zoomIndex - 1)] ?? 1)}
          />
          <Typography variant="mono" aria-label={t("zoom")}>
            {Math.round(zoom * 100)}%
          </Typography>
          <IconButton
            size="sm"
            icon="plus"
            label={t("zoomIn")}
            disabled={zoom >= maxZoom}
            onClick={() =>
              setZoom(zoomSteps.find((step) => step > zoom) ?? zoom)
            }
          />
          <IconButton
            size="sm"
            icon="fit"
            label={t("editorZoomReset")}
            disabled={zoom === 1}
            onClick={() => setZoom(1)}
          />
        </span>
        <IconButton
          size="sm"
          icon="trash"
          label={t("editorDeleteNotes")}
          disabled={selection.size === 0}
          onClick={() => session.remove(selection)}
        />
        <Typography
          className="editorHint"
          variant="caption"
          tone="muted"
          truncate
        >
          {t("editorHint")}
        </Typography>
      </Toolbar>

      <PianoRoll
        className="editorRoll"
        label={t("melodyEditor")}
        notes={document.notes}
        words={document.words}
        duration={duration}
        position={session.position}
        selected={selection}
        zoom={zoom}
        onZoomChange={setZoom}
        minPitch={lowest}
        maxPitch={highest}
        follow={follow && session.playing}
        grid={grid}
        nudgeSeconds={snapGridSeconds}
        onSelect={session.select}
        onSelectArea={(ids, additive) =>
          session.setSelection(
            (current) => new Set([...(additive ? current : []), ...ids]),
          )
        }
        onSeek={(value) => void session.seek(value)}
        onNoteDrag={drag}
        onNoteDragEnd={dragEnd}
        onNudge={(id, pitch, seconds) =>
          session.move(new Set([id]), pitch, seconds)
        }
      />
    </main>
  );
};
