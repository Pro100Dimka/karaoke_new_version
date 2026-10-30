import { BrowserWindow, app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { ShellStatus } from "./DesktopShell";
import { shellText, type ShellTextKey } from "./ShellText";

/** Theme primary colours; the splash glows in the colour of the theme the user picked last. */
const themeGlow = {
  dark: "#ff153f",
  light: "#e31d63",
  green: "#2fff8d",
  violet: "#b85cff",
} as const;

export type ThemeName = keyof typeof themeGlow;
export const themeNames = Object.keys(themeGlow) as ThemeName[];

const splashSizePixels = 420;
const themeFile = (): string =>
  path.join(app.getPath("userData"), "theme.json");

export const isThemeName = (value: unknown): value is ThemeName =>
  typeof value === "string" && (themeNames as string[]).includes(value);

export const readSavedTheme = (): ThemeName => {
  try {
    const raw = JSON.parse(fs.readFileSync(themeFile(), "utf8")) as {
      theme?: unknown;
    };
    return isThemeName(raw.theme) ? raw.theme : "dark";
  } catch {
    return "dark";
  }
};

export const saveTheme = (theme: ThemeName): void => {
  try {
    fs.writeFileSync(themeFile(), JSON.stringify({ theme }));
  } catch {
    // Only the next launch's splash colour depends on it.
  }
};

let splash: BrowserWindow | null = null;
let splashStatus = "";
let splashProgress: number | null | undefined;

const showStatus = (): void => {
  void splash?.webContents
    .executeJavaScript(`window.setStatus && window.setStatus(${JSON.stringify(splashStatus)}, ${JSON.stringify(splashProgress)})`)
    .catch(() => undefined);
};

/** A line under the icon (an update being downloaded and installed); empty hides it. */
export const setSplashStatus = (text: string, progress?: number | null): void => {
  splashStatus = text;
  splashProgress = progress;
  if (splash && !splash.webContents.isLoading()) showStatus();
};

/** Keep the verified-data cleanup visible after the installer exits and releases its own file. */
export const waitForStorageMigration = async (language: ShellStatus["language"]): Promise<void> => {
  const root = app.getPath("appData");
  const file = path.join(root, "storage-progress.json");
  const pending = () => [".storage-cleanup", ".storage-migration"].some((name) => fs.existsSync(path.join(root, name)));
  if (!pending() && !fs.existsSync(file)) return;
  const phases: Record<string, ShellTextKey> = {
    Prepare: "storagePrepare", Copy: "storageCopy", Catalog: "storageCatalog",
    Verify: "storageVerify", Publish: "storagePublish", Waiting: "storageWaiting",
    Cleanup: "storageCleanup", Done: "storageDone",
  };
  let updatedAt = Date.now();
  for (;;) {
    let state: unknown;
    try {
      state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    } catch {
      throw new Error(shellText(language, "storageInterrupted"));
    }
    if (state && typeof state === "object" && "phase" in state && typeof state.phase === "string") {
      if (state.phase === "Error") {
        const detail = "detail" in state && typeof state.detail === "string" ? state.detail : "";
        throw new Error(`${shellText(language, "storageFailed")}\n\n${detail}`);
      }
      if (state.phase === "Done" && !pending()) {
        setSplashStatus(shellText(language, "storageDone"), 1);
        await delay(1500);
        try {
          fs.rmSync(file, { force: true });
        } catch (error) {
          console.warn("Cannot clear migration progress", error);
        }
        return;
      }
      if ("updatedAt" in state && typeof state.updatedAt === "number") updatedAt = state.updatedAt;
      const done = "done" in state && typeof state.done === "number" ? state.done : 0;
      const total = "total" in state && typeof state.total === "number" ? state.total : 0;
      const seconds = "elapsed" in state && typeof state.elapsed === "number" ? state.elapsed : 0;
      const phase = Object.hasOwn(phases, state.phase) ? phases[state.phase]! : "storagePrepare";
      setSplashStatus(`${shellText(language, phase)}\n${shellText(language, total > 0 ? "storageProgress" : "storageElapsed", { done, total, seconds })}`,
        total > 0 ? Math.min(1, Math.max(0, done / total)) : null);
    } else {
      setSplashStatus(shellText(language, "storageWaiting"), null);
    }
    if (Date.now() - updatedAt > 15_000) throw new Error(shellText(language, "storageInterrupted"));
    await delay(500);
  }
};

/** A window-less startup screen: a transparent, frameless window that holds nothing but the animated icon. */
export const openSplash = (iconPath: string | null, htmlPath: string): void => {
  if (splash) return;
  const theme = readSavedTheme();
  splash = new BrowserWindow({
    width: splashSizePixels,
    height: splashSizePixels,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    center: true,
    show: false,
    backgroundColor: "#00000000",
    icon: iconPath ?? undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  splash.on("closed", () => {
    splash = null;
  });
  // Re-apply alpha to the native compositor surface. On Windows, waiting for
  // ready-to-show can replace transparent pixels with the default black surface.
  splash.setBackgroundColor("#00000000");
  splash.setIgnoreMouseEvents(true);
  splash.webContents.once("did-finish-load", () => {
    splash?.setBackgroundColor("#00000000");
    showStatus();
    splash?.showInactive();
  });
  void splash.loadFile(htmlPath, {
    query: {
      icon: iconPath ? pathToFileURL(iconPath).toString() : "",
      glow: themeGlow[theme],
    },
  });
};

export const closeSplash = (): void => {
  splash?.close();
  splash = null;
};
