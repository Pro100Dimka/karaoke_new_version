import {
  controlSelector,
  type PanelLayout,
  type ScreenPoint,
} from "./useFloatingPanel";

/**
 * The panel's window has no frame and no background of its own: it is exactly as large as the
 * panel, and follows it when the panel grows or shrinks (a participant joins, a section opens).
 * Returns the cleanup.
 */
export const fitWindowToPanel = (
  panel: Window,
  mount: HTMLElement,
): (() => void) => {
  // Without size notifications (never in Electron) the window keeps the size it opened with.
  if (typeof ResizeObserver === "undefined") return () => undefined;
  const fit = () => {
    const box = mount.firstElementChild?.getBoundingClientRect();
    if (!box || box.width < 1 || box.height < 1) return;
    const width = Math.ceil(box.width);
    const height = Math.ceil(box.height);
    if (width !== panel.innerWidth || height !== panel.innerHeight)
      panel.resizeTo(width, height);
  };
  const observer = new ResizeObserver(fit);
  observer.observe(mount);
  if (mount.firstElementChild) observer.observe(mount.firstElementChild);
  const children = new MutationObserver(() => {
    observer.disconnect();
    observer.observe(mount);
    if (mount.firstElementChild) observer.observe(mount.firstElementChild);
    fit();
  });
  children.observe(mount, { childList: true });
  return () => {
    observer.disconnect();
    children.disconnect();
  };
};

/** Where a point of the screen lies inside the app's own window, or undefined when outside it. */
const pointInApp = (
  screenX: number,
  screenY: number,
): { x: number; y: number } | undefined => {
  // The app's window draws its own title bar, so its frame is only what the outer size adds.
  const frameX = (window.outerWidth - window.innerWidth) / 2;
  const frameY = window.outerHeight - window.innerHeight - frameX;
  const x = screenX - window.screenX - frameX;
  const y = screenY - window.screenY - frameY;
  return x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight
    ? { x, y }
    : undefined;
};

/**
 * The panel's window is moved by grabbing the panel's own surface, the same way the panel is moved
 * inside the app; its controls keep working as usual. Dropped onto the app's window, the panel
 * goes back into the app at that place (`onDropInApp`, in the app's window pixels).
 */
export const moveWindowBySurface = (
  panel: Window,
  mount: HTMLElement,
  onDropInApp: (layout: PanelLayout) => void,
): (() => void) => {
  let grab: { x: number; y: number; pointerId: number } | null = null;
  const down = (event: PointerEvent) => {
    const target = event.target as Element | null;
    if (event.button !== 0 || target?.closest?.(controlSelector)) return;
    grab = {
      x: event.screenX - panel.screenX,
      y: event.screenY - panel.screenY,
      pointerId: event.pointerId,
    };
    mount.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const move = (event: PointerEvent) => {
    if (grab?.pointerId === event.pointerId)
      panel.moveTo(event.screenX - grab.x, event.screenY - grab.y);
  };
  const up = (event: PointerEvent) => {
    if (grab?.pointerId !== event.pointerId) return;
    const { x, y } = grab;
    grab = null;
    const inApp = pointInApp(event.screenX, event.screenY);
    if (inApp)
      onDropInApp({
        left: inApp.x - x,
        top: inApp.y - y,
        width: panel.innerWidth,
        height: panel.innerHeight,
      });
  };
  mount.addEventListener("pointerdown", down);
  mount.addEventListener("pointermove", move);
  mount.addEventListener("pointerup", up);
  mount.addEventListener("pointercancel", up);
  return () => {
    mount.removeEventListener("pointerdown", down);
    mount.removeEventListener("pointermove", move);
    mount.removeEventListener("pointerup", up);
    mount.removeEventListener("pointercancel", up);
  };
};

/**
 * A panel just torn off the app's window is still held: its new window follows the pointer until
 * the button is released, so one drag carries the panel out of the app and on to where it goes.
 * The app's window keeps the pointer while the button is held, so it hears the whole drag.
 * Releasing it stays a window wherever it lands: over a maximised app every point is "in the app",
 * so docking on release would snap it straight back. It returns by its button, or by dragging the
 * window onto the app afterwards (see moveWindowBySurface).
 */
export const carryWindow = (
  panel: Window,
  opened: PanelLayout,
  pointer: ScreenPoint,
): void => {
  // Measured from where the window was asked to open: a window just opened may not report it yet.
  const grabX = pointer.screenX - opened.left;
  const grabY = pointer.screenY - opened.top;
  const end = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
  };
  const move = (event: PointerEvent) => {
    // A release the app's window did not hear (e.g. over another program) still ends the drag.
    if (event.buttons === 0 || panel.closed) return end();
    panel.moveTo(event.screenX - grabX, event.screenY - grabY);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
};
