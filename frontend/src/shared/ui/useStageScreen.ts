import { useCallback, useEffect, useRef, useState } from "react";
import { keyBelongsToControl } from "./keyOwnership";
import { mirrorAppearance } from "./useDetachedPanel";

/** Must match electron/PanelWindows.ts: names starting so open full screen on the other display. */
export const stageScreenWindowName = "ad-voice-panel:stage-screen";
let opening = 0;

/**
 * The Karaoke stage (scene and lyrics) on a second screen, e.g. a TV: a full-screen window on the
 * other display that the app renders into (a portal into `container`), so nothing is duplicated —
 * the stage moves there and keeps its timing, scoring and audio. Escape in that window, closing it
 * or leaving Karaoke brings the stage back.
 */
export const useStageScreen = (title: string) => {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const opened = useRef<Window | null>(null);

  const close = useCallback(() => {
    const screenWindow = opened.current;
    opened.current = null;
    setContainer(null);
    screenWindow?.close();
  }, []);

  const open = useCallback(() => {
    if (opened.current && !opened.current.closed) return opened.current.focus();
    // A fresh name each time: a window of the same name that is still closing would otherwise be reused.
    opening += 1;
    const screenWindow = window.open("about:blank", `${stageScreenWindowName}-${opening}`, "width=1280,height=720");
    if (!screenWindow) return;
    screenWindow.document.title = title;
    const stopMirroring = mirrorAppearance(document, screenWindow.document);
    screenWindow.document.documentElement.setAttribute("data-stage-screen", "");
    const mount = screenWindow.document.createElement("div");
    mount.className = "stageScreen";
    screenWindow.document.body.append(mount);
    // The app's shortcuts (space for play/pause, …) work from the TV window too; Escape ends it.
    screenWindow.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        screenWindow.close();
        return;
      }
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
    screenWindow.addEventListener("pagehide", () => {
      stopMirroring();
      if (opened.current === screenWindow) {
        opened.current = null;
        setContainer(null);
      }
    });
    opened.current = screenWindow;
    setContainer(mount);
  }, [title]);

  useEffect(() => () => opened.current?.close(), []);

  return { container, active: container !== null, open, close };
};
