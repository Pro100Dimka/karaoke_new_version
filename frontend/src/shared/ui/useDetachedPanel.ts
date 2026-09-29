import { useCallback, useEffect, useRef, useState } from "react";
import { isRecord, readJson, storageKey, writeJson } from "../storage/localStore";

/** Must match electron/PanelWindows.ts: only windows with this name may open. */
const panelWindowPrefix = "ad-voice-panel:";

export interface PanelSize {
  width: number;
  height: number;
}

interface PanelBounds extends PanelSize {
  left?: number;
  top?: number;
}

const boundsKey = (id: string) => storageKey(`panelWindow.${id}`);

const savedBounds = (id: string, fallback: PanelSize): PanelBounds => {
  const saved = readJson(boundsKey(id));
  if (!isRecord(saved)) return fallback;
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  return {
    width: number(saved.width) ?? fallback.width,
    height: number(saved.height) ?? fallback.height,
    left: number(saved.left),
    top: number(saved.top),
  };
};

const features = ({ width, height, left, top }: PanelBounds): string =>
  [`width=${Math.round(width)}`, `height=${Math.round(height)}`,
    ...(left === undefined ? [] : [`left=${Math.round(left)}`]),
    ...(top === undefined ? [] : [`top=${Math.round(top)}`])].join(",");

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
    if (node instanceof HTMLStyleElement || (node instanceof HTMLLinkElement && node.rel === "stylesheet"))
      target.head.append(node.cloneNode(true));
  };
  source.head.childNodes.forEach(copy);
  const copyRoot = () => {
    for (const { name, value } of [...source.documentElement.attributes]) target.documentElement.setAttribute(name, value);
    target.body.className = source.body.className;
  };
  copyRoot();
  const styles = new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(copy)));
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
 * window, or the panel leaving the app (e.g. karaoke ends), brings it back.
 */
export const useDetachedPanel = (id: string, title: string, size: PanelSize) => {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const opened = useRef<Window | null>(null);

  const attach = useCallback(() => {
    const panel = opened.current;
    opened.current = null;
    setContainer(null);
    panel?.close();
  }, []);

  const detach = useCallback(() => {
    if (opened.current && !opened.current.closed) return opened.current.focus();
    const panel = window.open("about:blank", `${panelWindowPrefix}${id}`, features(savedBounds(id, size)));
    if (!panel) return;
    panel.document.title = title;
    const stopMirroring = mirrorAppearance(document, panel.document);
    const mount = panel.document.createElement("div");
    mount.className = "detachedPanel";
    panel.document.body.append(mount);
    panel.addEventListener("pagehide", () => {
      writeJson(boundsKey(id), {
        width: panel.innerWidth, height: panel.innerHeight, left: panel.screenX, top: panel.screenY,
      });
      stopMirroring();
      if (opened.current === panel) {
        opened.current = null;
        setContainer(null);
      }
    });
    opened.current = panel;
    setContainer(mount);
  }, [id, size, title]);

  useEffect(() => () => opened.current?.close(), []);

  return { container, detached: container !== null, detach, attach };
};
