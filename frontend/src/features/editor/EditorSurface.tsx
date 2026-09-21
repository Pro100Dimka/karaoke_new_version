import { useEffect, useMemo, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { useText } from "../../i18n/useText";
import {
  moveNotes,
  resizeNote,
  snapGridSeconds,
  snapTime,
  type EditorDocument,
  type EditorNote
} from "./editorModel";

const basePixelsPerSecond = 100;
const rowHeight = 18;
const headerHeight = 58;

type Drag =
  | { kind: "move"; before: EditorDocument; ids: ReadonlySet<string>; x: number; y: number }
  | { kind: "resize"; before: EditorDocument; id: string; edge: "start" | "end"; x: number };

interface EditorSurfaceProps {
  document: EditorDocument;
  selection: ReadonlySet<string>;
  zoom: number;
  durationSeconds: number;
  position: number;
  follow: boolean;
  snap: boolean;
  playing: boolean;
  onSelect(id: string, additive: boolean): void;
  onSeek(seconds: number): void;
  onPreview(next: EditorDocument): void;
  onCommit(before: EditorDocument, after: EditorDocument): void;
  onNudge(id: string, pitch: number, seconds: number): void;
}

export const EditorSurface = ({
  document,
  selection,
  zoom,
  durationSeconds,
  position,
  follow,
  snap,
  playing,
  onSelect,
  onSeek,
  onPreview,
  onCommit,
  onNudge
}: EditorSurfaceProps) => {
  const t = useText();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const latest = useRef(document);
  latest.current = document;
  const pps = basePixelsPerSecond * zoom;

  const range = useMemo(() => {
    const pitches = document.notes.map(note => note.pitch);
    const low = pitches.length ? Math.min(...pitches) : 55;
    const high = pitches.length ? Math.max(...pitches) : 70;
    return { min: low - 5, max: high + 5 };
  }, [document.notes]);
  const rows = range.max - range.min + 1;
  const yOf = (pitch: number): number => headerHeight + (range.max - pitch) * rowHeight;
  const xOf = (seconds: number): number => seconds * pps;

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !follow || !playing) return;
    const target = xOf(position) - scroller.clientWidth * 0.3;
    scroller.scrollLeft = Math.max(0, target);
    // eslint follows the playhead only while playing.
  }, [position, follow, playing, pps]);

  const startMove = (event: PointerEvent<HTMLButtonElement>, note: EditorNote) => {
    if (event.button !== 0) return;
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    const ids = selection.has(note.id) && !additive ? selection : new Set([...(additive ? selection : []), note.id]);
    onSelect(note.id, additive);
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { kind: "move", before: latest.current, ids, x: event.clientX, y: event.clientY };
  };

  const startResize = (event: PointerEvent<HTMLButtonElement>, note: EditorNote, edge: "start" | "end") => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { kind: "resize", before: latest.current, id: note.id, edge, x: event.clientX };
  };

  const handleMove = (event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const seconds = snapTime((event.clientX - drag.x) / pps, snap);
    if (drag.kind === "move") {
      const rowsMoved = -Math.round((event.clientY - drag.y) / rowHeight);
      onPreview(moveNotes(drag.before, drag.ids, rowsMoved, seconds));
      return;
    }
    const note = drag.before.notes.find(item => item.id === drag.id);
    if (!note) return;
    const origin = drag.edge === "start" ? note.start : note.end;
    onPreview(resizeNote(drag.before, drag.id, drag.edge, snapTime(origin + (event.clientX - drag.x) / pps, snap)));
  };

  const handleUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag && latest.current !== drag.before) onCommit(drag.before, latest.current);
  };

  const handleKey = (event: KeyboardEvent<HTMLButtonElement>, note: EditorNote) => {
    const step = snapGridSeconds;
    const moves: Record<string, [number, number]> = {
      ArrowUp: [1, 0],
      ArrowDown: [-1, 0],
      ArrowLeft: [0, -step],
      ArrowRight: [0, step]
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    onNudge(note.id, move[0], move[1]);
  };

  const seekFromRuler = (event: PointerEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    onSeek(Math.max(0, (event.clientX - box.left) / pps));
  };

  const width = xOf(durationSeconds);
  const canvasStyle = { width, height: headerHeight + rows * rowHeight } satisfies CSSProperties;
  const seconds = Array.from({ length: Math.ceil(durationSeconds) + 1 }, (_, index) => index);

  return (
    <section className="editorSurface" aria-label={t("melodyEditor")}>
      <div className="pitchLabels" aria-hidden style={{ paddingTop: headerHeight }}>
        {Array.from({ length: rows }, (_, index) => range.max - index).map(pitch => (
          <span key={pitch} style={{ height: rowHeight }}>
            {pitch % 12 === 0 ? `C${pitch / 12 - 1}` : pitch}
          </span>
        ))}
      </div>
      <div className="noteScroller" ref={scrollerRef}>
        <div className="noteCanvas" style={canvasStyle} onPointerMove={handleMove} onPointerUp={handleUp}>
          <button type="button" className="timeRuler" aria-label={t("songPosition")} onPointerDown={seekFromRuler}>
            {seconds.map(second => (
              <span key={second} style={{ left: xOf(second) }}>
                {second % 5 === 0 ? second : ""}
              </span>
            ))}
          </button>
          <div className="wordTrack" style={{ top: 24 }}>
            {document.words.map(word => (
              <span key={word.id} style={{ left: xOf(word.start), width: xOf(word.end - word.start) }}>
                {word.text}
              </span>
            ))}
          </div>
          <span className="playhead" aria-hidden style={{ left: xOf(position) }} />
          {document.notes.map(note => {
            const selected = selection.has(note.id);
            return (
              <div
                key={note.id}
                className={selected ? "noteBox selected" : "noteBox"}
                style={{ left: xOf(note.start), top: yOf(note.pitch), width: Math.max(6, xOf(note.end - note.start)), height: rowHeight - 2 }}
              >
                <button
                  type="button"
                  className="noteBody"
                  aria-label={t("noteLabel", { pitch: note.pitch })}
                  aria-pressed={selected}
                  onPointerDown={event => startMove(event, note)}
                  onKeyDown={event => handleKey(event, note)}
                >
                  {note.pitch}
                </button>
                <button
                  type="button"
                  className="noteHandle start"
                  aria-label={t("resizeNoteStart")}
                  onPointerDown={event => startResize(event, note, "start")}
                />
                <button
                  type="button"
                  className="noteHandle end"
                  aria-label={t("resizeNoteEnd")}
                  onPointerDown={event => startResize(event, note, "end")}
                />
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};
