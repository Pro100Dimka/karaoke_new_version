import { app, screen, type BrowserWindow } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { ipcChannels } from "./ipcChannels";

export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
  /** Full screen over the taskbar, chosen from the title bar (or still on from Karaoke's F11). */
  fullscreen: boolean;
}

// No minimum size: the window may be made as small as the user wants (e.g. half a screen).
const defaultWindowState: WindowState = {
  width: 1440,
  height: 900,
  maximized: false,
  fullscreen: false,
};
const windowStatePath = (): string =>
  path.join(app.getPath("userData"), "window-state.json");

const isVisibleOnSomeDisplay = (x: number, y: number): boolean =>
  screen
    .getAllDisplays()
    .some(
      ({ workArea }) =>
        x >= workArea.x - 40 &&
        y >= workArea.y - 10 &&
        x + 120 <= workArea.x + workArea.width &&
        y + 60 <= workArea.y + workArea.height,
    );

export const loadWindowState = (): WindowState => {
  try {
    const raw = JSON.parse(
      fs.readFileSync(windowStatePath(), "utf8"),
    ) as Partial<WindowState>;
    const state: WindowState = {
      ...defaultWindowState,
      maximized: raw.maximized === true,
      fullscreen: raw.fullscreen === true,
    };
    for (const dimension of ["width", "height"] as const) {
      const value = raw[dimension];
      if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
        state[dimension] = value;
    }
    // A saved position on a monitor that no longer exists falls back to the primary display.
    if (
      typeof raw.x === "number" &&
      typeof raw.y === "number" &&
      isVisibleOnSomeDisplay(raw.x, raw.y)
    ) {
      return { ...state, x: raw.x, y: raw.y };
    }
    return state;
  } catch {
    return defaultWindowState;
  }
};

export const saveWindowState = (window: BrowserWindow): void => {
  const bounds =
    window.isMaximized() || window.isFullScreen()
      ? window.getNormalBounds()
      : window.getBounds();
  const state: WindowState = {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    maximized: window.isMaximized(),
    fullscreen: window.isFullScreen(),
  };
  try {
    fs.writeFileSync(windowStatePath(), JSON.stringify(state));
  } catch {
    // Window placement is a convenience; failing to persist it must not block closing.
  }
};

export const publishWindowState = (window: BrowserWindow): void => {
  window.webContents.send(ipcChannels.windowState, {
    maximized: window.isMaximized(),
    fullscreen: window.isFullScreen(),
    minimized: window.isMinimized(),
  });
};
