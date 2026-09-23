import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { useApp } from "../../app/AppContext";
import type { PianoRollLayout } from "../../shared/preferences/preferences";

export const defaultPianoRollHeight = 180;
const defaultPianoRollWidth = 920;
const minWidth = 320;
const minHeight = 100;
const maxHeight = 480;
// A drag this short is read as a plain click (select only); anything past it is a real move/resize.
const dragThresholdPixels = 3;

/** Which edges of the panel a resize handle moves; a corner combines its two edges' effects. */
export type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

type Drag =
  | { kind: "move"; startX: number; startY: number; origin: PianoRollLayout }
  | { kind: "resize"; edge: ResizeEdge; startX: number; startY: number; origin: PianoRollLayout };

// The panel is position: fixed (see karaoke.css), so its left/top/width/height already live in the same
// viewport-pixel space as getBoundingClientRect() and window.innerWidth/innerHeight -- no separate
// container to translate against, and nothing stops it reaching the area under the console either.
const clampToWindow = (next: PianoRollLayout): PianoRollLayout => {
  const width = Math.min(Math.max(next.width, minWidth), window.innerWidth);
  const height = Math.min(Math.max(next.height, minHeight), maxHeight);
  const left = Math.min(Math.max(next.left, 0), Math.max(0, window.innerWidth - width));
  const top = Math.min(Math.max(next.top, 0), Math.max(0, window.innerHeight - height));
  return { left, top, width, height };
};

const resized = (origin: PianoRollLayout, edge: ResizeEdge, dx: number, dy: number): PianoRollLayout => {
  let { left, top, width, height } = origin;
  if (edge.includes("e")) {
    width = origin.width + dx;
  } else if (edge.includes("w")) {
    // The right edge (left + width) is the anchor: it must not move while dragging the left edge.
    width = origin.width - dx;
    left = origin.left + origin.width - width;
  }
  if (edge.includes("s")) {
    height = origin.height + dy;
  } else if (edge.includes("n")) {
    // The bottom edge (top + height) is the anchor: it must not move while dragging the top edge.
    height = origin.height - dy;
    top = origin.top + origin.height - height;
  }
  return clampToWindow({ left, top, width, height });
};

/**
 * Lets the user click the piano roll to select it, drag it anywhere on screen, and resize it from every
 * edge (single axis) or corner (both axes); the chosen layout is saved (frontend/src/shared/preferences)
 * and reapplied on every future karaoke session instead of the default centred one.
 */
export const usePianoRollLayout = (frameRef: RefObject<HTMLDivElement | null>) => {
  const { preferences, updatePreferences } = useApp();
  const [active, setActive] = useState(false);
  const [live, setLive] = useState<PianoRollLayout | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const movedRef = useRef(false);

  const layout = live ?? preferences.pianoRollLayout;

  const currentBox = (): PianoRollLayout => {
    if (layout) return layout;
    const rect = frameRef.current?.getBoundingClientRect();
    return rect
      ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      : { left: 0, top: 0, width: defaultPianoRollWidth, height: defaultPianoRollHeight };
  };

  const beginMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    movedRef.current = false;
    dragRef.current = { kind: "move", startX: event.clientX, startY: event.clientY, origin: currentBox() };
  };

  const beginResize = (edge: ResizeEdge) => (event: ReactPointerEvent<HTMLSpanElement>) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    movedRef.current = false;
    dragRef.current = { kind: "resize", edge, startX: event.clientX, startY: event.clientY, origin: currentBox() };
  };

  const handleMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    // Below the threshold this stays a plain click: the layout is left untouched, not even nudged by a
    // stray pixel of jitter, so a click never visibly moves or resaves the panel's placement.
    if (!movedRef.current && Math.abs(dx) <= dragThresholdPixels && Math.abs(dy) <= dragThresholdPixels) return;
    movedRef.current = true;
    const next =
      drag.kind === "move"
        ? clampToWindow({ ...drag.origin, left: drag.origin.left + dx, top: drag.origin.top + dy })
        : resized(drag.origin, drag.edge, dx, dy);
    setLive(next);
  };

  const handleUp = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setActive(true);
    // A plain click only selects the panel; it never changes or saves its layout. live already holds the
    // final dragged/resized value from the last handleMove, so it is only read here, not derived again.
    if (movedRef.current && live) updatePreferences({ pianoRollLayout: live });
  };

  const deactivate = useCallback(() => setActive(false), []);

  // Clicking outside the panel deselects it, the same way a selection elsewhere on a canvas would.
  useEffect(() => {
    if (!active) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !frameRef.current?.contains(event.target)) deactivate();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [active, deactivate, frameRef]);

  return { layout, active, beginMove, beginResize, handleMove, handleUp };
};
