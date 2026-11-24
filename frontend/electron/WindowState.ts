import { app, screen, type BrowserWindow } from 'electron';
import * as fs from 'node:fs';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { ipcChannels } from './ipcChannels';

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
  path.join(app.getPath('userData'), 'window-state.json');

const findSavedDisplay = (x: number, y: number) =>
  screen
    .getAllDisplays()
    .find(
      ({ workArea }) =>
        x >= workArea.x - 40 &&
        y >= workArea.y - 10 &&
        x + 120 <= workArea.x + workArea.width &&
        y + 60 <= workArea.y + workArea.height,
    );

export const loadWindowState = (): WindowState => {
  try {
    const file = windowStatePath();
    const raw = JSON.parse(
      saving && acceptedSave?.file === file
        ? acceptedSave.text
        : fs.readFileSync(file, 'utf8'),
    ) as Partial<WindowState>;
    const state: WindowState = {
      ...defaultWindowState,
      maximized: raw.maximized === true,
      fullscreen: raw.fullscreen === true,
    };
    for (const dimension of ['width', 'height'] as const) {
      const value = raw[dimension];
      if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
        state[dimension] = value;
    }
    // A saved position on a monitor that no longer exists falls back to the primary display.
    const { x, y } = raw;
    if (typeof x !== 'number' || typeof y !== 'number') return state;
    const display = findSavedDisplay(x, y);
    if (!display) return state;

    const { workArea } = display;
    const width = Math.min(state.width, workArea.width);
    const height = Math.min(state.height, workArea.height);
    return {
      ...state,
      width,
      height,
      x: Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width)),
      y: Math.max(
        workArea.y,
        Math.min(y, workArea.y + workArea.height - height),
      ),
    };
  } catch {
    return defaultWindowState;
  }
};

let saving: Promise<void> | undefined;
let nextSave: { file: string; text: string } | undefined;
let acceptedSave: typeof nextSave;

/** The quit path awaits accepted placement writes after the window has closed. */
export const flushWindowState = (): Promise<void> =>
  saving ?? Promise.resolve();

export const saveWindowState = (window: BrowserWindow): Promise<void> => {
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
  // Capture native bounds before the window disappears. An in-flight write is
  // followed only by the newest accepted placement, never an unbounded queue.
  nextSave = acceptedSave = {
    file: windowStatePath(),
    text: JSON.stringify(state),
  };
  saving ??= Promise.resolve().then(async () => {
    try {
      while (nextSave) {
        const next = nextSave;
        nextSave = undefined;
        try {
          await writeFile(next.file, next.text);
        } catch {
          // Placement is a convenience; a failed save must not reject closing.
        }
      }
    } finally {
      saving = undefined;
      acceptedSave = undefined;
    }
  });
  return saving;
};

export const publishWindowState = (
  window: BrowserWindow,
  transition: Partial<{
    maximized: boolean;
    fullscreen: boolean;
    minimized: boolean;
  }> = {},
): void => {
  window.webContents.send(ipcChannels.windowState, {
    maximized: window.isMaximized(),
    fullscreen: window.isFullScreen(),
    minimized: window.isMinimized(),
    ...transition,
  });
};
