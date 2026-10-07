import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { isThemeName } from "./Splash";

/** The repository root in development; the installed resources folder in a release. */
export const projectRoot = (): string =>
  app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "..", "..");

export const pythonRoot = (): string =>
  app.isPackaged
    ? path.join(process.resourcesPath, "python-app")
    : path.join(projectRoot(), "python");

const storageRootFile = (): string => path.join(app.getPath("userData"), "storage-root.txt");

/** Where the backend keeps songs and data: the folder the user chose, else the environment's or the default. */
export const configuredStorageRoot = (): string => {
  try {
    const saved = fs.readFileSync(storageRootFile(), "utf8").trim();
    if (saved && path.isAbsolute(saved)) return saved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const fromEnvironment = process.env.AD_VOICE_DATA?.trim();
  if (fromEnvironment) return fromEnvironment;
  return path.join(app.getPath("userData"), "backend-data");
};

/** Takes effect at the next start: the running backend keeps the folder it opened. */
export const saveStorageRoot = (folder: string): void => {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(storageRootFile(), folder, "utf8");
};

export const audioExecutable = (): string => {
  const configured = process.env.AD_VOICE_AUDIO_SERVICE;
  if (configured) return configured;
  const name = process.platform === "win32" ? "AudioService.exe" : "AudioService";
  const candidates = [
    path.join(projectRoot(), "AudioService", "build", "Release", name),
    path.join(projectRoot(), "AudioService", "build", name),
    path.join(process.resourcesPath, "audio-service", name),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0] ?? name;
};

export const themeIconPath = (theme: string): string | null => {
  if (!isThemeName(theme)) return null;
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, "theme-icons", `${theme}.png`)
    : path.join(projectRoot(), "frontend", "src", "assets", "theme-icons", `${theme}.png`);
  return fs.existsSync(candidate) ? candidate : null;
};
