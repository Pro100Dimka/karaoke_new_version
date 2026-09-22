import { BrowserWindow, app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/** Theme primary colours; the splash glows in the colour of the theme the user picked last. */
const themeGlow = {
  dark: "#ff153f",
  light: "#e31d63",
  green: "#2fff8d",
  violet: "#b85cff"
} as const;

export type ThemeName = keyof typeof themeGlow;
export const themeNames = Object.keys(themeGlow) as ThemeName[];

const splashSizePixels = 420;
const themeFile = (): string => path.join(app.getPath("userData"), "theme.json");

export const isThemeName = (value: unknown): value is ThemeName =>
  typeof value === "string" && (themeNames as string[]).includes(value);

export const readSavedTheme = (): ThemeName => {
  try {
    const raw = JSON.parse(fs.readFileSync(themeFile(), "utf8")) as { theme?: unknown };
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
    center: true,
    show: false,
    backgroundColor: "#00000000",
    icon: iconPath ?? undefined,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
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
    splash?.showInactive();
  });
  void splash.loadFile(htmlPath, {
    query: {
      icon: iconPath ? pathToFileURL(iconPath).toString() : "",
      glow: themeGlow[theme]
    }
  });
};

export const closeSplash = (): void => {
  splash?.close();
  splash = null;
};
