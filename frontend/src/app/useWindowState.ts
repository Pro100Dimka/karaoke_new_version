import { useEffect, useState } from "react";
import { desktopClient } from "../services/desktopClient";

export const useWindowState = (): WindowState => {
  const [state, setState] = useState<WindowState>({
    maximized: false,
    fullscreen: false,
    minimized: false,
  });

  useEffect(() => {
    let active = true;
    let receivedEvent = false;
    const unsubscribe = desktopClient.onWindowState((next) => {
      if (!active) return;
      receivedEvent = true;
      setState(next);
    });
    void Promise.all([
      desktopClient.isMaximized(),
      desktopClient.isFullscreen(),
    ]).then(([maximized, fullscreen]) => {
      if (active && !receivedEvent)
        setState({ maximized, fullscreen, minimized: false });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return state;
};
