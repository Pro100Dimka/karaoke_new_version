import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { useDetachedPanel } from "../../../shared/ui/useDetachedPanel";
import { useFloatingPanel, type useStoredPanelLayout } from "../../../shared/ui/useFloatingPanel";

/** Before the console is first laid out (and in tests), the height its design starts from. */
export const consoleDesignHeight = 320;

/** The element's real height, followed as its content changes; the drag limits use it, not a guess. */
const useMeasuredHeight = (ref: RefObject<HTMLElement | null>): number => {
  const [height, setHeight] = useState(consoleDesignHeight);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (element.offsetHeight > 0) setHeight(element.offsetHeight);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return height;
};

interface ConsoleFrameProps {
  panel: ReturnType<typeof useDetachedPanel>;
  placement: ReturnType<typeof useStoredPanelLayout>;
  /** The console's designed width in pixels. */
  width: number;
  shown: boolean;
  label: string;
  children: ReactNode;
}

/**
 * The console's movable frame. Dragging changes only this component's state, so the console's content (waveform,
 * knobs, presets) is not drawn again on every pointer move: React keeps the same `children` as they were.
 */
export const ConsoleFrame = ({ panel, placement, width, shown, label, children }: ConsoleFrameProps) => {
  const frameRef = useRef<HTMLElement>(null);
  const height = useMeasuredHeight(frameRef);
  const size = useMemo(() => ({ width, height }), [width, height]);
  const floating = useFloatingPanel(frameRef, {
    // The console has no resize handles: only its place is kept, its size is always the designed one
    // (squeezed by a small window, back to full when the window grows).
    layout: placement.layout && { ...placement.layout, ...size },
    onLayoutChange: placement.save,
    defaultSize: size,
    onDragOutside: (bounds, pointer) => panel.detach(bounds, pointer),
  });
  const style = !panel.detached && floating.layout
    ? { position: "fixed" as const, left: floating.layout.left, top: floating.layout.top, inlineSize: floating.layout.width }
    : undefined;

  return (
    <aside
      className="karaokeConsolePanel"
      aria-label={label}
      data-hidden={!shown || undefined}
      aria-hidden={!shown}
      ref={frameRef}
      style={style}
      onPointerDown={panel.detached ? undefined : floating.beginMove}
      onPointerMove={panel.detached ? undefined : floating.handleMove}
      onPointerUp={panel.detached ? undefined : floating.handleUp}
    >
      {children}
    </aside>
  );
};
