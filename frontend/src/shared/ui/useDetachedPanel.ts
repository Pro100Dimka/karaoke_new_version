import { useCallback, useEffect, useRef, useState } from "react";
import {
  isRecord,
  readJson,
  storageKey,
  writeJson,
} from "../storage/localStore";
import {
  carryWindow,
  fitWindowToPanel,
  moveWindowBySurface,
} from "./detachedWindow";
import { keyBelongsToControl } from "./keyOwnership";
import type { PanelLayout, ScreenPoint } from "./useFloatingPanel";

/** Must match electron/PanelWindows.ts: only windows with this name may open. */
const panelWindowPrefix = "ad-voice-panel:";

export interface PanelSize {
  width: number;
  height: number;
}

export interface PanelBounds extends PanelSize {
  left?: number;
  top?: number;
}

const boundsKey = (id: string) => storageKey(`panelWindow.${id}`);

const savedBounds = (id: string, fallback: PanelSize): PanelBounds => {
  const saved = readJson(boundsKey(id));
  if (!isRecord(saved)) return fallback;
  const number = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  return {
    width: number(saved.width) ?? fallback.width,
    height: number(saved.height) ?? fallback.height,
    left: number(saved.left),
    top: number(saved.top),
  };
};

const features = ({ width, height, left, top }: PanelBounds): string =>
  [
    `width=${Math.round(width)}`,
    `height=${Math.round(height)}`,
    ...(left === undefined ? [] : [`left=${Math.round(left)}`]),
    ...(top === undefined ? [] : [`top=${Math.round(top)}`]),
  ].join(",");

/**
 * The panel window shows the app's own styles and theme: every stylesheet (including ones loaded
 * later with a page), the base address their fonts resolve against, and the root attributes that
 * carry the theme. Returns the cleanup that stops mirroring.
 */
const mirrorAppearance = (source: Document, target: Document): (() => void) => {
  const base = target.createElement("base");
  base.href = source.baseURI;
  target.head.append(base);
  const copy = (node: Node) => {
    if (
      node instanceof HTMLStyleElement ||
      (node instanceof HTMLLinkElement && node.rel === "stylesheet")
    )
      target.head.append(node.cloneNode(true));
  };
  for (const node of source.head.childNodes) copy(node);
  const copyRoot = () => {
    for (const { name, value } of [...source.documentElement.attributes])
      target.documentElement.setAttribute(name, value);
    target.body.className = source.body.className;
  };
  copyRoot();
  const styles = new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) copy(node);
  });
  styles.observe(source.head, { childList: true });
  const root = new MutationObserver(copyRoot);
  root.observe(source.documentElement, { attributes: true });
  root.observe(source.body, { attributes: true, attributeFilter: ["class"] });
  return () => {
    styles.disconnect();
    root.disconnect();
  };
};

/**
 * Moves a panel of the app into a window of its own that can be dragged anywhere, even onto
 * another screen, and back. The window is drawn by this app (a portal into `container`), so the
 * panel keeps all of its state, controls and audio. It remembers where it was put; closing the
 * window, dropping it onto the app's window, or the panel leaving the app (e.g. karaoke ends)
 * brings it back; a drop places it where it was dropped (`onReturn`).
 */
export const useDetachedPanel = (
  id: string,
  title: string,
  size: PanelSize,
  onReturn?: (layout: PanelLayout) => void,
) => {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const opened = useRef<Window | null>(null);
  const returned = useRef(onReturn);
  returned.current = onReturn;

  const attach = useCallback(() => {
    const panel = opened.current;
    opened.current = null;
    setContainer(null);
    panel?.close();
  }, []);

  /**
   * Opens the panel's window where it was last left, or at `at` (screen pixels) when torn off; a
   * torn-off panel still held by `pointer` follows it until released.
   */
  const detach = useCallback(
    (at?: PanelBounds, pointer?: ScreenPoint) => {
      if (opened.current && !opened.current.closed)
        return opened.current.focus();
      const bounds = at ?? savedBounds(id, size);
      const panel = window.open(
        "about:blank",
        `${panelWindowPrefix}${id}`,
        features(bounds),
      );
      if (!panel) return;
      panel.document.title = title;
      const stopMirroring = mirrorAppearance(document, panel.document);
      // An attribute, not a class: the app's root attributes mirrored onto this window replace its class.
      panel.document.documentElement.setAttribute("data-panel-window", "");
      const mount = panel.document.createElement("div");
      mount.className = "detachedPanel";
      // The panel keeps the width (and, for panels sized by their frame, the height) it had in the app.
      mount.style.setProperty(
        "--detached-panel-width",
        `${Math.round(bounds.width)}px`,
      );
      mount.style.setProperty(
        "--detached-panel-height",
        `${Math.round(bounds.height)}px`,
      );
      panel.document.body.append(mount);
      const stopFitting = fitWindowToPanel(panel, mount);
      const dropInApp = (layout: PanelLayout) => {
        returned.current?.(layout);
        attach();
      };
      const stopMoving = moveWindowBySurface(panel, mount, dropInApp);
      if (pointer && at?.left !== undefined && at.top !== undefined)
        carryWindow(
          panel,
          { left: at.left, top: at.top, width: at.width, height: at.height },
          pointer,
        );
      // Shortcuts belong to the app: keys pressed in the panel's window reach the app's window too.
      panel.addEventListener("keydown", (event) => {
        if (keyBelongsToControl(event.target, event.key)) return;
        const forwarded = new KeyboardEvent("keydown", {
          key: event.key,
          code: event.code,
          shiftKey: event.shiftKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          cancelable: true,
        });
        if (!window.dispatchEvent(forwarded)) event.preventDefault();
      });
      panel.addEventListener("pagehide", () => {
        writeJson(boundsKey(id), {
          width: panel.innerWidth,
          height: panel.innerHeight,
          left: panel.screenX,
          top: panel.screenY,
        });
        stopMirroring();
        stopFitting();
        stopMoving();
        if (opened.current === panel) {
          opened.current = null;
          setContainer(null);
        }
      });
      opened.current = panel;
      setContainer(mount);
    },
    [attach, id, size, title],
  );

  useEffect(() => () => opened.current?.close(), []);

  return { container, detached: container !== null, detach, attach };
};
