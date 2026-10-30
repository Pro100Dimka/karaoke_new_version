import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { refreshMotion } from "@neo-ui-kit/react";
import { useHostWindow } from "../../../shared/ui/hostWindow";
import { pointInApp } from "../../../shared/ui/detachedWindow";
import type { useDetachedPanel } from "../../../shared/ui/useDetachedPanel";
import type { ConsolePlacement } from "./KaraokeConsole";
import {
  useFloatingPanel,
  useMeasuredPanelSize,
  controlSelector,
  type useStoredPanelLayout,
} from "../../../shared/ui/useFloatingPanel";

/** Before the console is first laid out (and in tests), the height its design starts from. */
export const consoleDesignHeight = 220;

interface ConsoleFrameProps {
  panel: ReturnType<typeof useDetachedPanel>;
  placement: ReturnType<typeof useStoredPanelLayout>;
  /** The console's designed width in pixels. */
  width: number;
  shown: boolean;
  label: string;
  children: ReactNode;
  dock?: ConsolePlacement;
  vertical: boolean;
  onFloat(): void;
}

/**
 * The console's movable frame. Dragging changes only this component's state, so the console's content (waveform,
 * knobs, presets) is not drawn again on every pointer move: React keeps the same `children` as they were.
 */
export const ConsoleFrame = ({
  panel,
  placement,
  width,
  shown,
  label,
  children,
  dock = "free",
  vertical,
  onFloat,
}: ConsoleFrameProps) => {
  useEffect(refreshMotion, [shown]);
  const host = useHostWindow();
  const frameRef = useRef<HTMLElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const grab = useRef<{ x: number; y: number; pointerId: number; detaching?: boolean } | null>(null);
  const { height } = useMeasuredPanelSize(surfaceRef, { width, height: consoleDesignHeight }, true, "layout");
  const readViewport = () => ({
    width: host.innerWidth,
    height: host.innerHeight,
    top: (host.document.querySelector(".titleBar")?.getBoundingClientRect().height ?? 40) + 24,
  });
  const [viewport, setViewport] = useState(readViewport);
  useEffect(() => {
    const follow = () => setViewport(readViewport());
    follow();
    host.addEventListener("resize", follow);
    return () => host.removeEventListener("resize", follow);
  }, [host]);
  const scale = panel.detached && panel.container
    ? panel.container.clientWidth / width
    : Math.min(1.1, Math.max(1, viewport.width - 16) / width,
      Math.max(1, viewport.height - viewport.top - 8) / height);
  const size = useMemo(() => ({ width: width * scale, height: height * scale }), [width, height, scale]);
  const floating = useFloatingPanel(frameRef, {
    layout: dock === "free" && placement.layout ? { ...placement.layout, ...size } : null,
    onLayoutChange: (layout) => { placement.save(layout); onFloat(); },
    defaultSize: size,
    ignore: ".ad-popover",
  });
  const beginMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as Element).closest(`${controlSelector}, .ad-popover`)) return;
    const box = event.currentTarget.getBoundingClientRect();
    grab.current = { x: event.clientX - box.left, y: event.clientY - box.top, pointerId: event.pointerId };
    floating.beginMove(event);
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const held = grab.current;
    if (held?.pointerId === event.pointerId && !held.detaching) {
      const left = event.clientX - held.x;
      const top = event.clientY - held.y;
      if (left < 0 || top < 0 || left + size.width > host.innerWidth || top + size.height > host.innerHeight) {
        held.detaching = true;
        panel.detach({ ...size, left: event.screenX - held.x, top: event.screenY - held.y }, event);
        return;
      }
    }
    floating.handleMove(event);
  };
  // Restoring the saved placement resets the floating hook; resume once its size is settled.
  useLayoutEffect(() => {
    if (panel.detached) { grab.current = null; floating.handleCancel(); return; }
    const pointer = panel.heldPointer.current;
    const frame = frameRef.current;
    if (panel.detached || !pointer || !frame || surfaceRef.current?.offsetHeight !== height) return;
    panel.heldPointer.current = null;
    const point = pointInApp(pointer.screenX, pointer.screenY);
    if (!point) return;
    frame.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, button: 0, buttons: 1, pointerId: pointer.pointerId,
      clientX: point.x, clientY: point.y, screenX: pointer.screenX, screenY: pointer.screenY,
    }));
  });
  const center = (viewport.width - size.width) / 2;
  const bottom = viewport.height - size.height - 8;
  const position = floating.layout && (dock === "free" || grab.current || panel.heldPointer.current)
    ? grab.current || panel.heldPointer.current ? floating.layout : {
      left: Math.max(8, Math.min(viewport.width - size.width - 8, floating.layout.left)),
      top: Math.max(viewport.top, Math.min(bottom, floating.layout.top)),
    }
    : {
      top: { left: center, top: viewport.top },
      bottom: { left: center, top: bottom },
      left: { left: 8, top: viewport.top },
      right: { left: viewport.width - size.width - 8, top: viewport.top },
      free: { left: center, top: bottom },
    }[dock];

  return (
    <aside
      className="karaokeConsolePanel"
      aria-label={label}
      data-hidden={!shown || undefined}
      data-ad-paused={!shown || undefined}
      aria-hidden={!shown}
      data-dock={panel.detached ? undefined : dock}
      data-orientation={vertical ? "vertical" : "horizontal"}
      ref={frameRef}
      style={{ inlineSize: size.width, blockSize: size.height, ...(panel.detached ? {} : position) }}
      onPointerDown={panel.detached ? undefined : beginMove}
      onPointerMove={panel.detached ? undefined : move}
      onPointerUp={panel.detached ? undefined : () => { grab.current = null; floating.handleUp(); }}
      onPointerCancel={panel.detached ? undefined : () => { grab.current = null; floating.handleCancel(); }}
    >
      <div ref={surfaceRef} className="consoleSurface" style={{ inlineSize: width, zoom: scale }}>
        {children}
      </div>
    </aside>
  );
};
