import type { BrowserWindow, BrowserWindowConstructorOptions, HandlerDetails, WindowOpenHandlerResponse } from "electron";

/**
 * A panel of the app (room, karaoke console, piano roll) moved into a window of its own. The
 * renderer opens an empty same-origin window with this name prefix and renders the panel into it,
 * so the panel keeps the app's state and audio; nothing else may open a window.
 */
export const panelWindowPrefix = "ad-voice-panel:";

export const panelWindowOpenHandler =
  (icon: string | undefined) =>
  ({ url, frameName }: HandlerDetails): WindowOpenHandlerResponse => {
    if (url !== "about:blank" || !frameName.startsWith(panelWindowPrefix)) return { action: "deny" };
    const options: BrowserWindowConstructorOptions = {
      // Only the panel itself is seen: no Windows title bar, nothing around the panel. The panel is
      // moved by its own surface and sized to itself by the renderer (useDetachedPanel).
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      icon,
      // No preload: the panel runs no code of its own, and has no access to the app's IPC.
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    };
    return { action: "allow", overrideBrowserWindowOptions: options };
  };

/** A panel window shows only what the app renders into it: it navigates nowhere and opens nothing. */
export const securePanelWindow = (panel: BrowserWindow): void => {
  panel.webContents.on("will-navigate", event => event.preventDefault());
  panel.webContents.on("will-redirect", event => event.preventDefault());
  panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
};
