import {
  screen,
  type BrowserWindow,
  type BrowserWindowConstructorOptions,
  type HandlerDetails,
  type Rectangle,
  type WindowOpenHandlerResponse,
} from "electron";

/**
 * A panel of the app (room, karaoke console, piano roll) moved into a window of its own. The
 * renderer opens an empty same-origin window with this name prefix and renders the panel into it,
 * so the panel keeps the app's state and audio; nothing else may open a window.
 */
export const panelWindowPrefix = "ad-voice-panel:";
/** Karaoke on a TV (src/features/karaoke/tv/useTvWindow.ts). */
export const stageScreenWindowName = `${panelWindowPrefix}stage-screen`;

/** The display to show the stage on: another one than the app's, else the app's own. */
export const stageScreenDisplay = (
  displays: readonly { id: number; bounds: Rectangle }[],
  appDisplayId: number,
): { id: number; bounds: Rectangle } | undefined =>
  displays.find((display) => display.id !== appDisplayId) ?? displays.find((display) => display.id === appDisplayId);

export const panelWindowOpenHandler =
  (icon: string | undefined, appBounds?: () => Rectangle) =>
  ({ url, frameName }: HandlerDetails): WindowOpenHandlerResponse => {
    if (url !== "about:blank" || !frameName.startsWith(panelWindowPrefix))
      return { action: "deny" };
    // The renderer numbers each opening (a closing window of the same name must not be reused).
    if (frameName === stageScreenWindowName || frameName.startsWith(`${stageScreenWindowName}-`)) {
      const appDisplay = appBounds ? screen.getDisplayMatching(appBounds()).id : screen.getPrimaryDisplay().id;
      const target = stageScreenDisplay(screen.getAllDisplays(), appDisplay);
      // An opaque, full-screen window on the TV: the stage (scene and lyrics) fills it edge to edge.
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          ...(target ? { x: target.bounds.x, y: target.bounds.y, width: target.bounds.width, height: target.bounds.height } : {}),
          frame: false,
          fullscreen: true,
          backgroundColor: "#000000",
          autoHideMenuBar: true,
          icon,
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
        },
      };
    }
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
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    };
    return { action: "allow", overrideBrowserWindowOptions: options };
  };

/** A panel window shows only what the app renders into it: it navigates nowhere and opens nothing. */
export const securePanelWindow = (panel: BrowserWindow): void => {
  panel.webContents.on("will-navigate", (event) => event.preventDefault());
  panel.webContents.on("will-redirect", (event) => event.preventDefault());
  panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
};
