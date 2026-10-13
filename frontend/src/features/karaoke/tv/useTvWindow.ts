import { useCallback, useEffect, useRef, useState } from "react";
import { mirrorAppearance } from "../../../shared/ui/useDetachedPanel";

/** Must match electron/PanelWindows.ts: names starting so open full screen on the other display. */
export const tvWindowName = "ad-voice-panel:stage-screen";
let opening = 0;

export interface TvScreen {
  window: Window;
  /** Where Karaoke is rendered (a portal) while it is on the TV. */
  container: HTMLElement;
}

/**
 * The TV: a full-screen window on the other display that the app renders Karaoke into, so the
 * session (audio, recording, scoring) carries on while it moves there and back. `onClosed` runs
 * when the window goes away by itself (the person closed it), not after `close()`.
 */
export const useTvWindow = (onClosed: () => void) => {
  const [screen, setScreen] = useState<TvScreen | null>(null);
  const opened = useRef<TvScreen | null>(null);
  const closed = useRef(onClosed);
  closed.current = onClosed;

  const close = useCallback(() => {
    const current = opened.current;
    opened.current = null;
    setScreen(null);
    current?.window.close();
  }, []);

  const open = useCallback((title: string): TvScreen | null => {
    if (opened.current && !opened.current.window.closed) {
      opened.current.window.focus();
      return opened.current;
    }
    // A fresh name each time: a window of the same name that is still closing would otherwise be reused.
    opening += 1;
    const tv = window.open("about:blank", `${tvWindowName}-${opening}`, "width=1280,height=720");
    if (!tv) return null;
    tv.document.title = title;
    const stopMirroring = mirrorAppearance(document, tv.document);
    // An attribute, not a class: the app's root attributes mirrored onto this window replace its class.
    tv.document.documentElement.setAttribute("data-tv-screen", "");
    const container = tv.document.createElement("div");
    container.className = "tvScreen";
    tv.document.body.append(container);
    const next = { window: tv, container };
    tv.addEventListener("pagehide", () => {
      stopMirroring();
      if (opened.current !== next) return;
      opened.current = null;
      setScreen(null);
      closed.current();
    });
    opened.current = next;
    setScreen(next);
    return next;
  }, []);

  useEffect(
    () => () => {
      const current = opened.current;
      opened.current = null;
      current?.window.close();
    },
    [],
  );

  return { screen, open, close };
};
