/*
 * Editor-local viewport rendering of @neo-ui-kit/react 1.4.15 PianoRoll.
 * Geometry, markup and gesture semantics adapted under its MIT license:
 * Copyright (c) 2026 pro100dimka
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import {
  clamp,
  isBlackKey,
  mark,
  PianoKeyboard,
  useControllable,
  useTr,
  type PianoRollGesture,
  type PianoRollProps,
  type TokenStyle,
} from '@neo-ui-kit/react';
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import type {
  EditorDocument,
  EditorNote,
} from '../../application/editor/editorModel';
import { editorRollIndex } from './editorRollWindow';
import { useEditorRollClock } from './useEditorRollClock';
import { useEditorDragPreview } from './useEditorDragPreview';
import {
  editorPixelsPerSecond,
  useEditorRollViewport,
} from './useEditorRollViewport';

export type EditorPianoRollProps = Omit<
  PianoRollProps,
  'notes' | 'words' | 'position'
> & {
  document: EditorDocument;
  readPosition(): number;
};
type Drag = { pointerId: number; x: number } & (
  | {
      kind: 'move';
      ids: readonly string[];
      y: number;
      secondPx: number;
      rowPx: number;
    }
  | { kind: 'resize'; id: string; edge: 'start' | 'end'; secondPx: number }
  | { kind: 'area'; y: number; additive: boolean; box: DOMRect }
);

const noteGesture = (
  current: Exclude<Drag, { kind: 'area' }>,
  x: number,
  y: number,
): PianoRollGesture =>
  current.kind === 'move'
    ? {
        kind: 'move',
        ids: current.ids,
        seconds: (x - current.x) / current.secondPx,
        pitch: -Math.round((y - current.y) / current.rowPx),
      }
    : {
        kind: 'resize',
        id: current.id,
        edge: current.edge,
        seconds: (x - current.x) / current.secondPx,
      };

export const EditorPianoRoll = ({
  document,
  readPosition,
  duration = 8,
  selected,
  zoom: zoomProp,
  defaultZoom = 1,
  onZoomChange,
  minPitch = 55,
  maxPitch = 79,
  follow = false,
  grid = true,
  nudgeSeconds = 0.05,
  onSelect,
  onSelectArea,
  onSeek,
  onNoteDrag,
  onNoteDragEnd,
  onNudge,
  onKeyPress,
  label,
  ...p
}: EditorPianoRollProps) => {
  const tr = useTr();
  const [zoom, setZoom] = useControllable(zoomProp, defaultZoom, onZoomChange);
  const root = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const areaBox = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const preview = useEditorDragPreview(onNoteDrag);
  const [captured, setCaptured] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const rows = maxPitch - minPitch + 1;
  const length = Math.max(duration, 1);
  const at = (seconds: number) => `calc(var(--ad-pps) * ${seconds})`;
  const row = (pitch: number) => `calc(100% * ${(maxPitch - pitch) / rows})`;
  const viewport = useEditorRollViewport(scroll, world, length, zoom);
  const noteIndex = useMemo(
    () => editorRollIndex(document.notes),
    [document.notes],
  );
  const wordIndex = useMemo(
    () => editorRollIndex(document.words),
    [document.words],
  );
  const notes = useMemo(
    () =>
      noteIndex.visible(viewport.start, viewport.end, [
        captured,
        focused,
        // Keep the native entry/exit tab stops in full document order.
        document.notes[0]?.id ?? null,
        document.notes.at(-1)?.id ?? null,
      ]),
    [
      noteIndex,
      viewport.start,
      viewport.end,
      captured,
      focused,
      document.notes,
    ],
  );
  const words = useMemo(
    () => wordIndex.visible(viewport.start, viewport.end),
    [wordIndex, viewport.start, viewport.end],
  );
  const visible = useMemo(
    () => ({ ...document, notes, words }),
    [document, notes, words],
  );
  useEditorRollClock(
    root,
    visible,
    readPosition,
    duration,
    zoom,
    follow,
    viewport.measure,
  );
  useLayoutEffect(() => {
    const id = pendingFocus.current;
    if (id === null) return;
    const note = [
      ...(world.current?.querySelectorAll<HTMLElement>('[data-note-id]') ?? []),
    ].find((element) => element.dataset.noteId === id);
    const button = note?.querySelector('button');
    if (!button) return;
    pendingFocus.current = null;
    // Preserve native vertical reveal as well as the horizontal window prepared below.
    button.focus();
  }, [focused, notes]);
  const scale = () => {
    const area = world.current?.getBoundingClientRect();
    return {
      secondPx: (area?.width ?? 1) / length,
      rowPx: (area?.height ?? rows) / rows,
    };
  };
  const startMove = (event: PointerEvent, note: EditorNote) => {
    if (event.button !== 0 || drag.current) return;
    event.stopPropagation();
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    const ids = selected?.has(note.id) && !additive ? [...selected] : [note.id];
    onSelect?.(note.id, additive);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setCaptured(note.id);
    drag.current = {
      kind: 'move',
      ids,
      x: event.clientX,
      y: event.clientY,
      ...scale(),
      pointerId: event.pointerId,
    };
  };
  const startResize = (
    event: PointerEvent,
    note: EditorNote,
    edge: 'start' | 'end',
  ) => {
    if (event.button !== 0 || drag.current) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setCaptured(note.id);
    drag.current = {
      kind: 'resize',
      id: note.id,
      edge,
      x: event.clientX,
      secondPx: scale().secondPx,
      pointerId: event.pointerId,
    };
  };
  const cancel = () => {
    const current = drag.current;
    drag.current = null;
    preview.cancel();
    setCaptured(null);
    if (!current) return;
    if (areaBox.current) areaBox.current.style.display = 'none';
    if (current.kind === 'area') return;
    onNoteDrag?.(
      current.kind === 'move'
        ? { kind: 'move', ids: current.ids, pitch: 0, seconds: 0 }
        : { kind: 'resize', id: current.id, edge: current.edge, seconds: 0 },
    );
    onNoteDragEnd?.();
  };
  const end = (event: PointerEvent) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (event.type !== 'pointerup') return cancel();
    drag.current = null;
    setCaptured(null);
    if (current.kind !== 'area') {
      // Release can arrive before the queued paint and after the last move sample.
      preview.finish(noteGesture(current, event.clientX, event.clientY));
      return onNoteDragEnd?.();
    }
    if (areaBox.current) areaBox.current.style.display = 'none';
    const { secondPx, rowPx } = scale();
    const x0 =
      (Math.min(current.x, event.clientX) - current.box.left) / secondPx;
    const x1 =
      (Math.max(current.x, event.clientX) - current.box.left) / secondPx;
    const top =
      maxPitch - (Math.max(current.y, event.clientY) - current.box.top) / rowPx;
    const bottom =
      maxPitch - (Math.min(current.y, event.clientY) - current.box.top) / rowPx;
    if (
      Math.abs(event.clientX - current.x) < 4 &&
      Math.abs(event.clientY - current.y) < 4
    )
      return onSeek?.(clamp(x0, 0, length));
    onSelectArea?.(
      document.notes
        .filter(
          (note) =>
            note.end >= x0 &&
            note.start <= x1 &&
            note.pitch >= top - 1 &&
            note.pitch <= bottom,
        )
        .map((note) => note.id),
      current.additive,
    );
  };
  const nudge = (event: KeyboardEvent, note: EditorNote) => {
    if (event.key === 'Tab') {
      const index = noteIndex.indexOf(note.id);
      const next =
        index === undefined
          ? undefined
          : document.notes[index + (event.shiftKey ? -1 : 1)];
      if (!next || !scroll.current) return;
      event.preventDefault();
      pendingFocus.current = next.id;
      setFocused(next.id);
      const pixels = editorPixelsPerSecond(world.current, length, zoom);
      const width = scroll.current.clientWidth || 1024;
      if (
        next.start * pixels < scroll.current.scrollLeft ||
        next.end * pixels > scroll.current.scrollLeft + width * 0.8
      )
        scroll.current.scrollLeft = Math.max(
          0,
          next.start * pixels - width * 0.3,
        );
      viewport.measure();
      return;
    }
    const steps: Record<string, [number, number]> = {
      ArrowUp: [1, 0],
      ArrowDown: [-1, 0],
      ArrowLeft: [0, -nudgeSeconds],
      ArrowRight: [0, nudgeSeconds],
    };
    const step = steps[event.key];
    if (!step) return;
    event.preventDefault();
    onNudge?.(note.id, step[0], step[1]);
  };
  const seconds = Array.from(
    {
      length: Math.max(
        0,
        Math.ceil(viewport.end) - Math.floor(viewport.start) + 1,
      ),
    },
    (_, i) => Math.floor(viewport.start) + i,
  );
  const style: TokenStyle = {
    ...p.style,
    '--ad-pps': `${4 * zoom}rem`,
    '--ad-roll-rows': rows,
  };
  return (
    <div
      {...mark('PianoRoll', p)}
      ref={root}
      role="application"
      aria-label={label ?? tr('Редактор мелодии')}
      data-grid={grid || undefined}
      style={style}
      onFocusCapture={(event) =>
        setFocused(
          (event.target as HTMLElement).closest<HTMLElement>('[data-note-id]')
            ?.dataset.noteId ?? null,
        )
      }
      onBlurCapture={(event) =>
        setFocused(
          event.relatedTarget instanceof HTMLElement
            ? (event.relatedTarget.closest<HTMLElement>('[data-note-id]')
                ?.dataset.noteId ?? null)
            : null,
        )
      }
    >
      <div
        className="ad-piano-roll-scroll"
        ref={scroll}
        onWheel={(event) => {
          if (!event.ctrlKey || !event.deltaY) return;
          event.preventDefault();
          setZoom(clamp(zoom * (event.deltaY > 0 ? 1 / 1.15 : 1.15), 0.25, 6));
        }}
      >
        <div className="ad-piano-roll-corner" />
        <div
          className="ad-piano-roll-ruler"
          style={{ width: at(length) }}
          onPointerDown={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            onSeek?.(
              clamp(
                ((event.clientX - box.left) / box.width) * length,
                0,
                length,
              ),
            );
          }}
        >
          {seconds.map((second) => (
            <span
              key={second}
              style={{ left: at(second) }}
              data-major={second % 5 === 0 || undefined}
            >
              {second}
            </span>
          ))}
          <i className="ad-piano-roll-head-mark" style={{ left: at(0) }} />
        </div>
        <PianoKeyboard
          className="ad-piano-roll-keys"
          minMidi={minPitch}
          maxMidi={maxPitch}
          labels="octaves"
          onKeyPress={onKeyPress}
        />
        <div
          className="ad-piano-roll-world"
          ref={world}
          style={{ width: at(length) }}
          onPointerDown={(event) => {
            if (event.button !== 0 || drag.current) return;
            event.currentTarget.setPointerCapture?.(event.pointerId);
            drag.current = {
              kind: 'area',
              x: event.clientX,
              y: event.clientY,
              additive: event.ctrlKey || event.metaKey || event.shiftKey,
              box: event.currentTarget.getBoundingClientRect(),
              pointerId: event.pointerId,
            };
          }}
          onPointerMove={(event) => {
            const current = drag.current;
            if (!current || current.pointerId !== event.pointerId) return;
            if (current.kind !== 'area')
              preview.queue(noteGesture(current, event.clientX, event.clientY));
            else if (areaBox.current)
              Object.assign(areaBox.current.style, {
                display: 'block',
                left: `${Math.min(current.x, event.clientX) - current.box.left}px`,
                top: `${Math.min(current.y, event.clientY) - current.box.top}px`,
                width: `${Math.abs(event.clientX - current.x)}px`,
                height: `${Math.abs(event.clientY - current.y)}px`,
              });
          }}
          onPointerUp={end}
          onPointerCancel={end}
          onLostPointerCapture={end}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && drag.current) {
              event.preventDefault();
              cancel();
            }
          }}
        >
          {Array.from({ length: rows }, (_, i) => maxPitch - i)
            .filter(isBlackKey)
            .map((pitch) => (
              <i
                key={pitch}
                className="ad-piano-roll-row"
                style={{ top: row(pitch) }}
              />
            ))}
          {notes.map((note) => (
            <div
              key={note.id}
              className="ad-piano-roll-note"
              data-note-id={note.id}
              data-selected={selected?.has(note.id) || undefined}
              style={{
                left: at(note.start),
                width: `max(0.25rem, ${at(note.end - note.start)})`,
                top: row(note.pitch),
              }}
            >
              <button
                type="button"
                className="ad-piano-roll-note-body"
                aria-label={tr('Нота {pitch}', { pitch: note.pitch })}
                aria-pressed={selected?.has(note.id) ?? false}
                onPointerDown={(event) => startMove(event, note)}
                onKeyDown={(event) => nudge(event, note)}
                onClick={(event) => {
                  if (event.detail === 0)
                    onSelect?.(
                      note.id,
                      event.ctrlKey || event.metaKey || event.shiftKey,
                    );
                }}
              />
              {(['start', 'end'] as const).map((edge) => (
                <span
                  key={edge}
                  className="ad-piano-roll-edge"
                  data-edge={edge}
                  aria-hidden="true"
                  onPointerDown={(event) => startResize(event, note, edge)}
                />
              ))}
            </div>
          ))}
          <div className="ad-piano-roll-area" ref={areaBox} />
          <span className="ad-piano-roll-playhead" style={{ left: at(0) }} />
        </div>
        {document.words.length > 0 && (
          <>
            <div className="ad-piano-roll-corner" />
            <div className="ad-piano-roll-words" style={{ width: at(length) }}>
              {words.map((word) => (
                <span
                  key={word.id}
                  data-word-id={word.id}
                  style={{
                    left: at(word.start),
                    width: at(word.end - word.start),
                  }}
                >
                  {word.text}
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
