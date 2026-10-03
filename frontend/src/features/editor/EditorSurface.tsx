import { useEffect, useMemo, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { NeonFrame } from "../../shared/ui/NeonFrame";
import { ReferenceArt } from "./EditorHeader";
import gridArtwork from "./assets/melody-editor-grid.svg?raw";
import rollArtwork from "./assets/melody-editor-roll-art.svg?raw";
import { moveNotes, resizeNote, snapGridSeconds, snapTime, type EditorDocument, type EditorNote } from "./editorModel";

const basePixelsPerSecond = 40;
const pitchStep = 8.8;
const c4Y = 229.5;
const preRoll = .5;

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
  tool: string;
  onSelect(id: string, additive: boolean): void;
  onSeek(seconds: number): void;
  onPreview(next: EditorDocument): void;
  onCommit(before: EditorDocument, after: EditorDocument): void;
  onNudge(id: string, pitch: number, seconds: number): void;
}

const blackPitch = (pitch: number) => [1, 3, 6, 8, 10].includes(pitch % 12);
const pitchLabel = (pitch: number) => `C${Math.floor(pitch / 12) - 1}`;

export const EditorSurface = ({ document, selection, zoom, durationSeconds, position, follow, snap, playing, tool, onSelect, onSeek, onPreview, onCommit, onNudge }: EditorSurfaceProps) => {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const latest = useRef(document);
  latest.current = document;
  const pps = basePixelsPerSecond * zoom;
  const toX = (seconds: number) => (seconds + preRoll) * pps;
  const toY = (pitch: number) => c4Y + (60 - pitch) * pitchStep;
  const width = Math.max(1189, (durationSeconds + preRoll) * pps);
  const measures = useMemo(() => Array.from({ length: Math.ceil(durationSeconds) + 1 }, (_, index) => index), [durationSeconds]);
  const pitches = useMemo(() => Array.from({ length: 41 }, (_, index) => 83 - index), []);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !follow || !playing) return;
    scroller.scrollLeft = Math.max(0, toX(position) - scroller.clientWidth * .3);
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
      onPreview(moveNotes(drag.before, drag.ids, -Math.round((event.clientY - drag.y) / pitchStep), seconds));
      return;
    }
    const note = drag.before.notes.find(item => item.id === drag.id);
    if (!note) return;
    const origin = drag.edge === "start" ? note.start : note.end;
    onPreview(resizeNote(drag.before, drag.id, drag.edge, snapTime(origin + (event.clientX - drag.x) / pps, snap)));
  };

  const finishDrag = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag && latest.current !== drag.before) onCommit(drag.before, latest.current);
  };

  const handleKey = (event: KeyboardEvent<HTMLButtonElement>, note: EditorNote) => {
    const movement: Record<string, [number, number]> = {
      ArrowUp: [1, 0], ArrowDown: [-1, 0], ArrowLeft: [0, -snapGridSeconds], ArrowRight: [0, snapGridSeconds]
    };
    const delta = movement[event.key];
    if (!delta) return;
    event.preventDefault();
    onNudge(note.id, delta[0], delta[1]);
  };

  const seek = (event: PointerEvent<HTMLButtonElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    onSeek(Math.max(0, (event.clientX - bounds.left) / pps - preRoll));
  };

  return (
    <section className="me-roll me-panel" aria-label="Редактор мелодии">
      <NeonFrame order={2} />
      <div className="me-roll-clip">
        <div className="me-ruler-corner" />
        <div className="me-piano" aria-label="Фортепианная клавиатура">
          {pitches.map(pitch => {
            const black = blackPitch(pitch);
            return <button key={pitch} type="button" className={`me-key me-key--${black ? "black" : "white"}`} style={{ top: toY(pitch) - 26 - (black ? 6.5 : 8.8), height: black ? 13 : 17.6 }} aria-label={`Нота ${pitch}`}>
              {!black && pitch % 12 === 0 && <span>{pitchLabel(pitch)}</span>}
            </button>;
          })}
        </div>
        <div className="me-grid-scroll" ref={scrollerRef}>
          <div className="me-world" data-tool={tool} style={{ width }} onPointerMove={handleMove} onPointerUp={finishDrag} onPointerCancel={finishDrag}>
            <ReferenceArt markup={gridArtwork} className="me-grid-svg me-grid-svg-art" />
            <button className="me-ruler" type="button" aria-label="Позиция песни" onPointerDown={seek}>
              {measures.map(second => <span className="me-measure" key={second} style={{ left: toX(second) }}>{second}</span>)}
            </button>
            <div className="me-words">
              {document.words.map(word => <span className="me-word" key={word.id} style={{ left: toX(word.start), width: Math.max(20, (word.end - word.start) * pps) }}>{word.text}</span>)}
            </div>
            <div className="me-note-layer">
              {document.notes.map(note => (
                <div key={note.id} className={`me-note${selection.has(note.id) ? " is-selected" : ""}`} style={{ left: toX(note.start), top: toY(note.pitch), width: Math.max(4, (note.end - note.start) * pps) }}>
                  <span className="me-note-face" />
                  <button className="me-note-body" type="button" aria-label={`Нота ${note.pitch}`} aria-pressed={selection.has(note.id)} onPointerDown={event => startMove(event, note)} onKeyDown={event => handleKey(event, note)} />
                  <button className="me-resize me-resize--start" type="button" aria-label="Изменить начало ноты" onPointerDown={event => startResize(event, note, "start")} />
                  <button className="me-resize me-resize--end" type="button" aria-label="Изменить конец ноты" onPointerDown={event => startResize(event, note, "end")} />
                </div>
              ))}
            </div>
            <span className="me-playhead" style={{ left: toX(position) }} />
          </div>
        </div>
        <ReferenceArt markup={rollArtwork} className="me-roll-art-wrap" />
      </div>
    </section>
  );
};
