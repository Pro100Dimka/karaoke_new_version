import { useEffect, useState } from "react";
import { desktopClient } from "../services/desktopClient";

export const useWindowState = (): WindowState => {
  const [state, setState] = useState<WindowState>({ maximized: false, fullscreen: false });

  useEffect(() => {
    let active = true;
    void Promise.all([desktopClient.isMaximized(), desktopClient.isFullscreen()]).then(
      ([maximized, fullscreen]) => active && setState({ maximized, fullscreen })
    );
    const unsubscribe = desktopClient.onWindowState(next => active && setState(next));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return state;
};
