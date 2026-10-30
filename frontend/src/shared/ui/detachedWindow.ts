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
  resizePanel = (width: number, height: number) => panel.resizeTo(width, height),
): (() => void) => {
  // Without size notifications (never in Electron) the window keeps the size it opened with.
  if (typeof ResizeObserver === "undefined") return () => undefined;
  const fit = () => {
    const box = mount.firstElementChild?.getBoundingClientRect();
    if (!box || box.width < 1 || box.height < 1) return;
    const width = Math.ceil(box.width);
    const height = Math.ceil(box.height);
    if (width !== panel.innerWidth || height !== panel.innerHeight)
      resizePanel(width, height);
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
export const pointInApp = (
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
  onDropInApp: (layout: PanelLayout, pointer?: PointerEvent) => void,
  movePanel = (left: number, top: number) => panel.moveTo(left, top),
  continuous = false,
): (() => void) => {
  let grab: { x: number; y: number; pointerId: number } | null = null;
  const down = (event: PointerEvent) => {
    const target = event.target as Element | null;
    if (event.button !== 0 || target?.closest?.(controlSelector)) return;
    if (continuous) carryWindow(panel, {
      left: panel.screenX, top: panel.screenY, width: panel.innerWidth, height: panel.innerHeight,
    }, event, onDropInApp, movePanel);
    else grab = {
      x: event.screenX - panel.screenX,
      y: event.screenY - panel.screenY,
      pointerId: event.pointerId,
    };
    mount.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const move = (event: PointerEvent) => {
    if (grab?.pointerId === event.pointerId)
      movePanel(event.screenX - grab.x, event.screenY - grab.y);
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
 * A caller can return it during the same drag once the whole panel is back inside the app.
 * Otherwise it stays a window until its next drag (see moveWindowBySurface).
 */
export const carryWindow = (
  panel: Window,
  opened: PanelLayout,
  pointer: ScreenPoint,
  onReenter?: (layout: PanelLayout, pointer: PointerEvent) => void,
  movePanel = (left: number, top: number) => panel.moveTo(left, top),
): void => {
  // Measured from where the window was asked to open: a window just opened may not report it yet.
  const grabX = pointer.screenX - opened.left;
  const grabY = pointer.screenY - opened.top;
  const hosts = onReenter ? [window, panel] : [window];
  const end = () => {
    for (const host of hosts) {
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerup", end);
      host.removeEventListener("pointercancel", cancel);
    }
  };
  const cancel = (event: PointerEvent) => {
    if (!onReenter || event.pointerType !== "mouse" || event.buttons === 0) end();
  };
  const move = (event: PointerEvent) => {
    // A release the app's window did not hear (e.g. over another program) still ends the drag.
    if (event.buttons === 0 || panel.closed) return end();
    if (onReenter && event.currentTarget === panel && !panel.document.body.hasPointerCapture(event.pointerId))
      panel.document.body.setPointerCapture(event.pointerId);
    const left = event.screenX - grabX;
    const top = event.screenY - grabY;
    const inside = onReenter && pointInApp(left, top);
    if (inside && pointInApp(left + opened.width, top + opened.height)) {
      end();
      onReenter?.({ left: inside.x, top: inside.y, width: opened.width, height: opened.height }, event);
      return;
    }
    movePanel(left, top);
  };
  for (const host of hosts) {
    host.addEventListener("pointermove", move);
    host.addEventListener("pointerup", end);
    host.addEventListener("pointercancel", cancel);
  }
};
