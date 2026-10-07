import { BrowserWindow } from "electron";
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
  /** Shows the window even if the renderer never reports that its first screen is ready. */
  reveal: () => void;
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
const watchRenderer = (window: BrowserWindow): (() => boolean) => {
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
  window.on("unresponsive", () => {
    unavailable = true;
  });
  window.on("responsive", () => {
    unavailable = false;
  });
  return () => unavailable;
};

export const createMainWindow = (options: MainWindowOptions): BrowserWindow => {
  const state = loadWindowState();
  const icon = themeIconPath(readSavedTheme()) ?? undefined;
  const window = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    frame: false,
    backgroundColor: "#101114",
    show: false,
    icon,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Panels moved into their own windows (room, console, piano roll) are drawn by this window's
      // timers; they must keep running while this window is minimised or covered.
      backgroundThrottling: false,
      additionalArguments: [`${roomParticipantArgument}${options.roomParticipant}`],
    },
  });
  if (state.maximized) window.maximize();

  const rendererUnavailable = watchRenderer(window);
  // The renderer decides whether the window may close (unsaved edits, recording, room, processing).
  window.on("close", (event) => {
    saveWindowState(window);
    if (options.closeConfirmed() || rendererUnavailable()) return;
    event.preventDefault();
    window.webContents.send(ipcChannels.closeRequested);
  });
  const publish = () => publishWindowState(window);
  window.on("maximize", publish);
  window.on("unmaximize", publish);
  window.on("minimize", publish);
  window.on("restore", publish);
  window.on("enter-full-screen", publish);
  window.on("leave-full-screen", publish);
  // A renderer that cannot load must still become visible so the user sees something.
  window.webContents.on("did-fail-load", () => options.reveal());

  guardNavigation(window, options.trustedIpc);
  window.webContents.setWindowOpenHandler(panelWindowOpenHandler(icon));
  const visibility = watchAppVisibility(window, (onScreen) => {
    if (!window.isDestroyed()) window.webContents.send(ipcChannels.appVisibility, onScreen);
  });
  window.webContents.on("did-finish-load", () => visibility.republish());
  window.webContents.on("did-create-window", (panel) => {
    securePanelWindow(panel);
    visibility.addPanel(panel);
  });
  void window.loadURL(options.rendererUrl);
  return window;
};
