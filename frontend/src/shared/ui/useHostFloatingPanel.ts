import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import {
  panelControls,
  type FloatingPanelOptions,
  type PanelLayout,
  type ResizeEdge,
} from '@neo-ui-kit/react';
import { useHostWindow } from './hostWindow';

/*
 * Adapted from @neo-ui-kit/react 1.4.15's floating-panel interaction contract.
 * That hook binds to global window/document and has no host option. A single local hook
 * keeps the same gestures while the existing panel moves between the app and its TV.
 *
 * MIT License — Copyright (c) 2026 pro100dimka
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

type Gesture = {
  x: number;
  y: number;
  origin: PanelLayout;
  next?: PanelLayout;
} & ({ kind: 'move' } | { kind: 'resize'; edge: ResizeEdge });

const threshold = 3;

export const useHostFloatingPanel = (
  frameRef: RefObject<HTMLElement | null>,
  options: FloatingPanelOptions,
) => {
  const host = useHostWindow();
  const [active, setActive] = useState(false);
  const [live, setLive] = useState<PanelLayout | null>(null);
  const drag = useRef<Gesture | null>(null);
  const moved = useRef(false);
  const latest = useRef(options);
  latest.current = options;
  const saved = options.layout;
  useLayoutEffect(() => {
    drag.current = null;
    setLive(null);
  }, [saved?.left, saved?.top, saved?.width, saved?.height, host]);
  useLayoutEffect(() => setActive(false), [host]);

  const [, refreshViewport] = useState(0);
  useEffect(() => {
    const resize = () => refreshViewport((value) => value + 1);
    host.addEventListener('resize', resize);
    resize();
    return () => host.removeEventListener('resize', resize);
  }, [host]);

  const keepInWindow = (next: PanelLayout): PanelLayout => {
    const { limits = {} } = latest.current;
    const width = Math.min(
      Math.max(next.width, limits.minWidth ?? 0),
      limits.maxWidth ?? Infinity,
      host.innerWidth,
    );
    const height = Math.min(
      Math.max(next.height, limits.minHeight ?? 0),
      limits.maxHeight ?? Infinity,
      host.innerHeight,
    );
    return {
      left: Math.min(
        Math.max(next.left, 0),
        Math.max(0, host.innerWidth - width),
      ),
      top: Math.min(
        Math.max(next.top, 0),
        Math.max(0, host.innerHeight - height),
      ),
      width,
      height,
    };
  };
  const placement = live ?? saved;
  const layout = placement ? keepInWindow(placement) : null;
  const box = (): PanelLayout => {
    if (layout) return layout;
    const rect = frameRef.current?.getBoundingClientRect();
    return rect?.width
      ? {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        }
      : { left: 0, top: 0, width: 0, height: 0, ...latest.current.defaultSize };
  };
  const resized = (
    origin: PanelLayout,
    edge: ResizeEdge,
    dx: number,
    dy: number,
  ) => {
    let { left, top, width, height } = origin;
    if (edge.includes('e')) width += dx;
    else if (edge.includes('w')) {
      width -= dx;
      left = origin.left + origin.width - width;
    }
    if (edge.includes('s')) height += dy;
    else if (edge.includes('n')) {
      height -= dy;
      top = origin.top + origin.height - height;
    }
    const bounded = keepInWindow({ left, top, width, height });
    if (edge.includes('w'))
      bounded.left = origin.left + origin.width - bounded.width;
    if (edge.includes('n'))
      bounded.top = origin.top + origin.height - bounded.height;
    return keepInWindow(bounded);
  };

  const beginMove = (event: PointerEvent<HTMLElement>) => {
    const { ignore } = latest.current;
    const controls = ignore ? `${panelControls}, ${ignore}` : panelControls;
    if (event.button !== 0 || (event.target as Element).closest?.(controls))
      return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    moved.current = false;
    drag.current = {
      kind: 'move',
      x: event.clientX,
      y: event.clientY,
      origin: box(),
    };
  };
  const beginResize =
    (edge: ResizeEdge) => (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      moved.current = false;
      drag.current = {
        kind: 'resize',
        edge,
        x: event.clientX,
        y: event.clientY,
        origin: box(),
      };
    };
  const handleMove = (event: PointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (
      !moved.current &&
      Math.abs(dx) <= threshold &&
      Math.abs(dy) <= threshold
    )
      return;
    moved.current = true;
    const { onDragOutside } = latest.current;
    const outside =
      event.clientX < 0 ||
      event.clientY < 0 ||
      event.clientX > host.innerWidth ||
      event.clientY > host.innerHeight;
    if (current.kind === 'move' && onDragOutside && outside) {
      drag.current = null;
      setLive(null);
      onDragOutside(
        {
          ...current.origin,
          left: event.screenX - (current.x - current.origin.left),
          top: event.screenY - (current.y - current.origin.top),
        },
        { screenX: event.screenX, screenY: event.screenY },
      );
      return;
    }
    current.next =
      current.kind === 'move'
        ? keepInWindow({
            ...current.origin,
            left: current.origin.left + dx,
            top: current.origin.top + dy,
          })
        : resized(current.origin, current.edge, dx, dy);
    setLive(current.next);
  };
  const handleUp = () => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    setActive(true);
    if (!moved.current || !current.next) return;
    const size = latest.current.layout ?? latest.current.defaultSize;
    latest.current.onLayoutChange?.(
      current.kind === 'move' && size
        ? { ...current.next, width: size.width, height: size.height }
        : current.next,
    );
  };
  const handleCancel = () => {
    if (!drag.current) return;
    setLive(drag.current.origin);
    drag.current = null;
  };
  const handleKeyDown = (
    event: KeyboardEvent<HTMLElement>,
    resizable = false,
  ) => {
    if (event.target !== event.currentTarget) return;
    const directions: Record<string, readonly [number, number]> = {
      ArrowLeft: [-10, 0],
      ArrowRight: [10, 0],
      ArrowUp: [0, -10],
      ArrowDown: [0, 10],
    };
    const delta = directions[event.key];
    if (!delta || (event.shiftKey && !resizable)) return;
    event.preventDefault();
    const origin = box();
    const next = event.shiftKey
      ? resized(origin, 'se', ...delta)
      : keepInWindow({
          ...origin,
          left: origin.left + delta[0],
          top: origin.top + delta[1],
        });
    setActive(true);
    setLive(next);
    latest.current.onLayoutChange?.(next);
  };

  useEffect(() => {
    if (!active) return;
    const outside = (event: globalThis.PointerEvent) => {
      const target = event.target;
      // A panel adopted into another document retains its original JavaScript realm.
      if (
        !target ||
        !('nodeType' in target) ||
        !frameRef.current?.contains(target as Node)
      )
        setActive(false);
    };
    host.document.addEventListener('pointerdown', outside);
    return () => host.document.removeEventListener('pointerdown', outside);
  }, [active, frameRef, host]);

  return {
    layout,
    active,
    beginMove,
    beginResize,
    handleMove,
    handleUp,
    handleCancel,
    handleKeyDown,
  };
};
