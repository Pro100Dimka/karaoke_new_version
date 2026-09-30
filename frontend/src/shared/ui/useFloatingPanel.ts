import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { isRecord, readJson, storageKey, writeJson } from "../storage/localStore";

/** Where a floating panel sits, in window pixels (or screen pixels for a torn-off window). */
export interface PanelLayout {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A point on the screen, in screen pixels. */
export interface ScreenPoint {
  screenX: number;
  screenY: number;
}

/** Which edges of the panel a resize handle moves; a corner combines its two edges' effects. */
export type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export interface FloatingPanelOptions {
  /** The saved placement, or null for the panel's own default place. */
  layout: PanelLayout | null;
  save(layout: PanelLayout): void;
  defaultSize: { width: number; height: number };
  /** Size limits for panels that can be resized from their edges. */
  limits?: { minWidth: number; minHeight: number; maxHeight: number };
  /**
   * The panel was dragged out of the app's window: it continues as a window of its own there, and
   * keeps following the pointer (`pointer`, screen pixels) until the button is released.
   */
  onTearOff?(screenBounds: PanelLayout, pointer: ScreenPoint): void;
}

// A drag this short is read as a plain click (select only); anything past it is a real move/resize.
const dragThresholdPixels = 3;

// Pressing a control inside the panel uses that control; only the panel's own surface moves it.
export const controlSelector = "button, a, input, select, textarea, [role=slider], [role=button], [role=listbox], [contenteditable=true]";

type Drag =
  | { kind: "move"; startX: number; startY: number; origin: PanelLayout }
  | { kind: "resize"; edge: ResizeEdge; startX: number; startY: number; origin: PanelLayout };

/**
 * Lets the user click a panel to select it, drag it anywhere in the app's window, optionally resize
 * it from every edge (single axis) or corner (both axes), and drag it past the window's edge to make
 * it a window of its own. The chosen placement is saved by the caller and reapplied next time.
 */
export const useFloatingPanel = (frameRef: RefObject<HTMLElement | null>, options: FloatingPanelOptions) => {
  const [active, setActive] = useState(false);
  const [live, setLive] = useState<PanelLayout | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const movedRef = useRef(false);
  const latest = useRef(options);
  latest.current = options;

  // A saved place is kept on screen: the window may have shrunk, or the panel grown, since then.
  const [, setViewport] = useState(0);
  useEffect(() => {
    const onResize = () => setViewport(count => count + 1);
    window.addEventListener("resize", onResize);
    // Measured once the panel is on screen, so its own size is known from the first frame.
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const onScreen = (saved: PanelLayout): PanelLayout => {
    const box = frameRef.current;
    const width = box?.offsetWidth || saved.width;
    const height = box?.offsetHeight || saved.height;
    return {
      ...saved,
      left: Math.min(Math.max(saved.left, 0), Math.max(0, window.innerWidth - width)),
      top: Math.min(Math.max(saved.top, 0), Math.max(0, window.innerHeight - height)),
    };
  };
  const layout = live ?? (options.layout && onScreen(options.layout));

  // The panel is position: fixed, so its box lives in the same viewport pixels as the window's size.
  const clampToWindow = (next: PanelLayout): PanelLayout => {
    const { limits } = latest.current;
    const width = Math.min(limits ? Math.max(next.width, limits.minWidth) : next.width, window.innerWidth);
    const height = limits ? Math.min(Math.max(next.height, limits.minHeight), limits.maxHeight) : next.height;
    const left = Math.min(Math.max(next.left, 0), Math.max(0, window.innerWidth - width));
    const top = Math.min(Math.max(next.top, 0), Math.max(0, window.innerHeight - height));
    return { left, top, width, height };
  };

  const resized = (origin: PanelLayout, edge: ResizeEdge, dx: number, dy: number): PanelLayout => {
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

  const currentBox = (): PanelLayout => {
    if (layout) return layout;
    const rect = frameRef.current?.getBoundingClientRect();
    return rect
      ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      : { left: 0, top: 0, ...latest.current.defaultSize };
  };

  const beginMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const target = event.target as Element | null;
    if (target?.closest?.(controlSelector)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    movedRef.current = false;
    dragRef.current = { kind: "move", startX: event.clientX, startY: event.clientY, origin: currentBox() };
  };

  const beginResize = (edge: ResizeEdge) => (event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    movedRef.current = false;
    dragRef.current = { kind: "resize", edge, startX: event.clientX, startY: event.clientY, origin: currentBox() };
  };

  const handleMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    // Below the threshold this stays a plain click: the layout is left untouched.
    if (!movedRef.current && Math.abs(dx) <= dragThresholdPixels && Math.abs(dy) <= dragThresholdPixels) return;
    movedRef.current = true;
    const { onTearOff } = latest.current;
    const outside = event.clientX < 0 || event.clientY < 0 ||
      event.clientX > window.innerWidth || event.clientY > window.innerHeight;
    if (drag.kind === "move" && onTearOff && outside) {
      dragRef.current = null;
      setLive(null);
      // The window appears where the panel was being held, the grab point still under the pointer.
      onTearOff({
        left: event.screenX - (drag.startX - drag.origin.left),
        top: event.screenY - (drag.startY - drag.origin.top),
        width: drag.origin.width,
        height: drag.origin.height,
      }, { screenX: event.screenX, screenY: event.screenY });
      return;
    }
    setLive(drag.kind === "move"
      ? clampToWindow({ ...drag.origin, left: drag.origin.left + dx, top: drag.origin.top + dy })
      : resized(drag.origin, drag.edge, dx, dy));
  };

  const handleUp = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setActive(true);
    // A plain click only selects the panel; it never changes or saves its layout.
    if (movedRef.current && live) latest.current.save(live);
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

const layoutKey = (id: string) => storageKey(`panelLayout.${id}`);

const storedLayout = (id: string): PanelLayout | null => {
  const saved = readJson(layoutKey(id));
  if (!isRecord(saved)) return null;
  const { left, top, width, height } = saved;
  return [left, top, width, height].every(value => typeof value === "number" && Number.isFinite(value))
    ? { left, top, width, height } as PanelLayout
    : null;
};

/** A floating panel's placement kept in this computer's storage, for panels without a preference of their own. */
export const useStoredPanelLayout = (id: string) => {
  const [layout, setLayout] = useState(() => storedLayout(id));
  const save = useCallback((next: PanelLayout) => {
    writeJson(layoutKey(id), next);
    setLayout(next);
  }, [id]);
  return { layout, save };
};
