import { BrowserWindow } from "electron";
import type { EventEmitter } from "node:events";
import * as path from "node:path";
import { themeIconPath } from "./AppPaths";
import { watchAppVisibility } from "./AppVisibility";
import { ipcChannels, roomParticipantArgument } from "./ipcChannels";
import { panelWindowOpenHandler, securePanelWindow } from "./PanelWindows";
import { readSavedTheme } from "./Splash";
import type { TrustedIpc } from "./TrustedIpc";
import { loadWindowState, publishWindowState, saveWindowState } from "./WindowState";

interface MainWindowOptions {
  rendererUrl: string;
  trustedIpc: TrustedIpc;
  roomParticipant: string;
  /** Whether the renderer already agreed to close (it decides about unsaved edits, rooms, …). */
  closeConfirmed: () => boolean;
  /** Hides the window to the tray instead of closing (the radio keeps playing); true when it did. */
  closeToTray?: () => boolean;
  /** Shows the window even if the renderer never reports that its first screen is ready. */
  reveal: () => void;
  log?: (source: string, level: string, message: string) => void;
}

/** Only the app's own pages may load; the about:srcdoc frame is the local animated backdrop. */
const guardNavigation = (window: BrowserWindow, trustedIpc: TrustedIpc): void => {
  const { webContents } = window;
  webContents.on("will-navigate", (event, url) => {
    if (!trustedIpc.isRendererUrl(url)) event.preventDefault();
  });
  webContents.on("will-frame-navigate", (event) => {
    const localBackdrop = !event.isMainFrame && event.url === "about:srcdoc";
    if (!localBackdrop && !trustedIpc.isRendererUrl(event.url)) event.preventDefault();
  });
  webContents.on("will-redirect", (event, url) => {
    if (!trustedIpc.isRendererUrl(url)) event.preventDefault();
  });
};

/**
 * Tracks whether the renderer can still answer a close request. A crashed or hung renderer cannot,
 * and the window could then only be ended from the Task Manager.
 */
const watchRenderer = (
  window: BrowserWindow,
  log?: (source: string, level: string, message: string) => void,
): (() => boolean) => {
  let unavailable = false;
  let lastReload = 0;
  window.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    unavailable = true;
    console.error(`Renderer process gone: ${details.reason}`);
    // One reload brings the app back; a renderer that keeps crashing is not reloaded in a loop.
    if (Date.now() - lastReload < 10_000) return;
    lastReload = Date.now();
    window.webContents.reload();
  });
  window.webContents.on("did-finish-load", () => {
    unavailable = false;
  });
  window.webContents.on("did-fail-load", (_event, _code, _description, _url, isMainFrame) => {
    if (isMainFrame) unavailable = true;
  });
  window.on("unresponsive", () => {
    unavailable = true;
    log?.("renderer", "warning", "Renderer unresponsive");
  });
  window.on("responsive", () => {
    unavailable = false;
    log?.("renderer", "info", "Renderer responsive");
  });
  return () => unavailable;
};

/**
 * The average colour of each theme's picture: what the window shows before the interface has painted
 * and in areas uncovered while resizing or entering full screen, so the light theme does not flash dark.
 */
export const themeWindowBackground = {
  dark: "#4d0b0f",
  light: "#f0d6ca",
  green: "#1a4b26",
  violet: "#592979",
} as const satisfies Record<ReturnType<typeof readSavedTheme>, string>;

export const createMainWindow = (options: MainWindowOptions): BrowserWindow => {
  const state = loadWindowState();
  const theme = readSavedTheme();
  const icon = themeIconPath(theme) ?? undefined;
  const window = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    frame: false,
    backgroundColor: themeWindowBackground[theme],
    show: false,
    icon,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Song titles, lyrics and names are not prose: no red underlines, and no Hunspell dictionaries
      // downloaded from Google's servers on first use.
      spellcheck: false,
      // Panels moved into their own windows (room, console, piano roll) are drawn by this window's
      // timers; they must keep running while this window is minimised or covered.
      backgroundThrottling: false,
      additionalArguments: [`${roomParticipantArgument}${options.roomParticipant}`],
    },
  });
  // The window opens the way it was closed: full screen over the taskbar, maximized, or as saved.
  if (state.fullscreen) window.once("show", () => window.setFullScreen(true));
  else if (state.maximized) window.once("show", () => window.maximize());

  const rendererUnavailable = watchRenderer(window, options.log);
  const captureConsole = (contents: BrowserWindow["webContents"]) =>
    contents.on("console-message", (details) =>
      options.log?.("renderer", details.level, details.message),
    );
  captureConsole(window.webContents);
  // The renderer decides whether the window may close (unsaved edits, recording, room, processing).
  window.on("close", (event) => {
    saveWindowState(window);
    if (options.closeToTray?.()) {
      event.preventDefault();
      return;
    }
    if (options.closeConfirmed() || rendererUnavailable()) return;
    event.preventDefault();
    window.webContents.send(ipcChannels.closeRequested);
  });
  // On Windows the event can arrive before the native query reflects the new state.
  const transitions = {
    maximize: { maximized: true }, unmaximize: { maximized: false },
    minimize: { minimized: true }, restore: { minimized: false },
    "enter-full-screen": { fullscreen: true }, "leave-full-screen": { fullscreen: false },
  };
  for (const [event, state] of Object.entries(transitions))
    (window as EventEmitter).on(event, () => publishWindowState(window, state));
  // A renderer that cannot load must still become visible so the user sees something.
  window.webContents.on("did-fail-load", (_event, code, description) => {
    options.log?.("renderer", "error", `Renderer failed to load (${code}): ${description}`);
    options.reveal();
  });

  guardNavigation(window, options.trustedIpc);
  window.webContents.setWindowOpenHandler(panelWindowOpenHandler(icon, () => window.getBounds(), window));
  const visibility = watchAppVisibility(window, (onScreen) => {
    if (!window.isDestroyed()) window.webContents.send(ipcChannels.appVisibility, onScreen);
  });
  window.webContents.on("did-finish-load", () => visibility.republish());
  window.webContents.on("did-create-window", (panel) => {
    securePanelWindow(panel);
    visibility.addPanel(panel);
    captureConsole(panel.webContents);
  });
  void window.loadURL(options.rendererUrl);
  return window;
};
