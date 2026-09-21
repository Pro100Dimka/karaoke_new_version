import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  shell,
} from "electron";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { waveformPeaks } from "./WavPeaks";
import { loadWindowState, minWindowHeight, minWindowWidth, publishWindowState, saveWindowState } from "./WindowState";
import { closeSplash, isThemeName, openSplash, readSavedTheme, saveTheme } from "./Splash";
import { sendAudioRequest, type AudioRequest } from "./AudioServiceTransport";
import { ipcChannels } from "./ipcChannels";
import { ServiceProcess } from "./ServiceProcess";

const currentDir = __dirname;
let mainWindow: BrowserWindow | null = null;
let pythonProcess: ServiceProcess | null = null;
let audioProcess: ServiceProcess | null = null;
let backendDataRoot = "";
let closeConfirmed = false;

const requireString = (value: unknown, name: string): string => {
  if (typeof value !== "string")
    throw new TypeError(`${name} must be a string`);
  return value;
};

const requireSafeExternalUrl = (value: unknown): string => {
  const rawUrl = requireString(value, "url");
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("Unsupported external URL protocol");
  }
  return url.toString();
};

const projectRoot = (): string => path.resolve(currentDir, "..", "..");
const pythonRoot = (): string => path.join(projectRoot(), "python");

const audioExecutable = (): string => {
  const configured = process.env.AD_VOICE_AUDIO_SERVICE;
  if (configured) return configured;
  const names =
    process.platform === "win32" ? ["AudioService.exe"] : ["AudioService"];
  const roots = [
    path.join(projectRoot(), "AudioService", "build", "Release"),
    path.join(projectRoot(), "AudioService", "build"),
    path.join(process.resourcesPath, "audio-service"),
  ];
  for (const root of roots) {
    for (const name of names) {
      const candidate = path.join(root, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return path.join(roots[0] ?? "", names[0] ?? "");
};

/**
 * A previous session may have left an AudioService behind (crash, stale build). It would keep the control pipe
 * and answer for the new process, so it is stopped before a fresh one is started.
 */
const stopStaleAudioService = (): void => {
  if (process.platform !== "win32") return;
  spawnSync("taskkill", ["/im", "AudioService.exe", "/f"], { windowsHide: true });
};

const startServices = (): void => {
  stopStaleAudioService();
  backendDataRoot =
    process.env.AD_VOICE_DATA ??
    path.join(app.getPath("userData"), "backend-data");
  const venvPython = path.join(pythonRoot(), ".venv", "Scripts", "python.exe");
  const python =
    process.env.AD_VOICE_PYTHON ??
    (fs.existsSync(venvPython) ? venvPython : process.platform === "win32" ? "python" : "python3");
  pythonProcess = new ServiceProcess(
    python,
    ["-m", "backend.main"],
    pythonRoot(),
    {
      ...process.env,
      AD_VOICE_DATA: backendDataRoot,
      AD_VOICE_PORT: process.env.AD_VOICE_PORT ?? "8765",
    },
  );
  pythonProcess.start();

  const executable = audioExecutable();
  if (fs.existsSync(executable)) {
    audioProcess = new ServiceProcess(executable, [], path.dirname(executable));
    audioProcess.start();
  } else {
    console.warn(`AudioService executable not found: ${executable}`);
  }
};

const stopServices = (): void => {
  void sendAudioRequest({ command: "ShutdownService" }).catch(() => undefined);
  audioProcess?.stop();
  pythonProcess?.stop();
};

const splashFallbackMilliseconds = 90_000;
let mainRevealed = false;

/** Swaps the splash for the main window; safe to call repeatedly. */
const revealMainWindow = (): void => {
  if (mainRevealed) return;
  mainRevealed = true;
  mainWindow?.show();
  closeSplash();
};

const createWindow = (): void => {
  const state = loadWindowState();
  const window = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: minWindowWidth,
    minHeight: minWindowHeight,
    frame: false,
    backgroundColor: "#101114",
    show: false,
    icon: themeIconPath(readSavedTheme()) ?? undefined,
    webPreferences: {
      preload: path.join(currentDir, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;
  if (state.maximized) window.maximize();

  // The renderer decides whether the window may close (unsaved edits, recording, room, processing).
  window.on("close", (event) => {
    saveWindowState(window);
    if (closeConfirmed) return;
    event.preventDefault();
    window.webContents.send(ipcChannels.closeRequested);
  });
  const publish = (): void => publishWindowState(window);
  window.on("maximize", publish);
  window.on("unmaximize", publish);
  window.on("enter-full-screen", publish);
  window.on("leave-full-screen", publish);
  window.on("closed", () => {
    mainWindow = null;
  });
  // A renderer that cannot load must still become visible so the user sees something.
  window.webContents.on("did-fail-load", () => revealMainWindow());

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) void window.loadURL(devServerUrl);
  else void window.loadFile(path.join(currentDir, "../dist/index.html"));
};

const requirePythonRequest = (
  value: unknown,
): {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
} => {
  if (!value || typeof value !== "object")
    throw new TypeError("request must be an object");
  const request = value as Record<string, unknown>;
  const method = requireString(request.method, "method").toUpperCase();
  const requestPath = requireString(request.path, "path");
  if (!new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]).has(method))
    throw new TypeError("Unsupported HTTP method");
  if (!requestPath.startsWith("/") || requestPath.startsWith("//"))
    throw new TypeError("Invalid backend path");
  const headers =
    request.headers && typeof request.headers === "object"
      ? (request.headers as Record<string, string>)
      : undefined;
  return { method, path: requestPath, body: request.body, headers };
};

const projectRevisionRoot = (songId: string, revision: number): string => {
  if (
    !/^[A-Za-z0-9._-]+$/.test(songId) ||
    !Number.isInteger(revision) ||
    revision < 1
  ) {
    throw new TypeError("Invalid project identity");
  }
  return path.join(
    backendDataRoot,
    "songs",
    songId,
    "revisions",
    String(revision),
  );
};

const inspectWave = (
  filePath: string,
): { sampleRate: number; channels: number; durationSeconds: number } => {
  const buffer = Buffer.alloc(44);
  const file = fs.openSync(filePath, "r");
  try {
    const bytes = fs.readSync(file, buffer, 0, buffer.length, 0);
    if (
      bytes < 44 ||
      buffer.toString("ascii", 0, 4) !== "RIFF" ||
      buffer.toString("ascii", 8, 12) !== "WAVE"
    ) {
      throw new Error("Invalid WAV recording");
    }
    const channels = buffer.readUInt16LE(22);
    const sampleRate = buffer.readUInt32LE(24);
    const byteRate = buffer.readUInt32LE(28);
    const dataBytes = buffer.readUInt32LE(40);
    return {
      sampleRate,
      channels,
      durationSeconds: byteRate > 0 ? dataBytes / byteRate : 0,
    };
  } finally {
    fs.closeSync(file);
  }
};

const projectArtifacts = (
  songId: string,
  revision: number,
): { instrumental: string; vocals?: string; lyricsSync?: string } => {
  const revisionRoot = projectRevisionRoot(songId, revision);
  const manifestPath = path.join(revisionRoot, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    artifacts?: unknown;
  };
  if (!Array.isArray(manifest.artifacts))
    throw new Error("Project manifest has no artifacts");
  const byName = new Map<string, string>();
  for (const item of manifest.artifacts) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (
      typeof record.logicalName !== "string" ||
      typeof record.relativePath !== "string"
    )
      continue;
    const resolved = path.resolve(revisionRoot, record.relativePath);
    const relative = path.relative(revisionRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Project artifact escapes revision root");
    byName.set(record.logicalName, resolved);
  }
  const instrumental = byName.get("instrumental");
  if (!instrumental) throw new Error("Instrumental artifact is missing");
  return {
    instrumental,
    vocals: byName.get("referenceVocal"),
    lyricsSync: byName.get("lyricsSync"),
  };
};

// One instance owns the services and the audio pipe; a second launch must not kill them, it only focuses the window.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();
app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(() => {
  if (!isPrimaryInstance) return;
  startServices();
  openSplash(themeIconPath(readSavedTheme()), path.join(currentDir, "..", "electron", "splash.html"));
  createWindow();
  setTimeout(revealMainWindow, splashFallbackMilliseconds);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let servicesStopped = false;
const stopServicesOnce = (): void => {
  closeSplash();
  if (servicesStopped || !isPrimaryInstance) return;
  servicesStopped = true;
  stopServices();
};
app.on("before-quit", stopServicesOnce);
app.on("will-quit", stopServicesOnce);
process.on("exit", stopServicesOnce);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle(ipcChannels.minimize, () => mainWindow?.minimize());
ipcMain.handle(ipcChannels.toggleMaximize, () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return mainWindow.isMaximized();
});
ipcMain.handle(ipcChannels.close, () => mainWindow?.close());
ipcMain.handle(
  ipcChannels.isMaximized,
  () => mainWindow?.isMaximized() ?? false,
);
ipcMain.handle(ipcChannels.pickAudioFile, async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [
      { name: "Audio", extensions: ["mp3", "wav", "flac", "m4a", "ogg"] },
    ],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});
ipcMain.handle(ipcChannels.reveal, (_event, targetPath: unknown) => {
  shell.showItemInFolder(requireString(targetPath, "path"));
});
ipcMain.handle(ipcChannels.openExternal, async (_event, value: unknown) => {
  await shell.openExternal(requireSafeExternalUrl(value));
});
ipcMain.handle(ipcChannels.copyText, (_event, value: unknown) => {
  clipboard.writeText(requireString(value, "text"));
});
ipcMain.handle(ipcChannels.pythonRequest, async (_event, raw: unknown) => {
  const request = requirePythonRequest(raw);
  const port = process.env.AD_VOICE_PORT ?? "8765";
  try {
    const response = await fetch(`http://127.0.0.1:${port}${request.path}`, {
      method: request.method,
      headers: { "Content-Type": "application/json", ...request.headers },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });
    const text = await response.text();
    const body: unknown = text ? JSON.parse(text) : null;
    return { status: response.status, ok: response.ok, body };
  } catch (error) {
    // A backend that is still starting or restarting is an expected state, reported as data instead of an IPC failure.
    const message = error instanceof Error ? error.message : "Python backend is unreachable";
    return { status: 503, ok: false, body: { code: "BackendUnavailable", message } };
  }
});
ipcMain.handle(ipcChannels.audioRequest, async (_event, raw: unknown) => {
  if (!raw || typeof raw !== "object")
    throw new TypeError("Audio request must be an object");
  const record = raw as Record<string, unknown>;
  const command = requireString(record.command, "command");
  const args =
    record.args && typeof record.args === "object"
      ? (record.args as AudioRequest["args"])
      : undefined;
  try {
    return await sendAudioRequest({ command, args });
  } catch (error) {
    // The pipe does not exist until AudioService has finished starting; report that as an ordinary failed response.
    const message = error instanceof Error ? error.message : "AudioService is unreachable";
    return { status: -1, text: `AudioService unavailable: ${message}` };
  }
});
ipcMain.handle(ipcChannels.resolveProjectArtifacts, (_event, raw: unknown) => {
  if (!raw || typeof raw !== "object")
    throw new TypeError("Project request must be an object");
  const record = raw as Record<string, unknown>;
  const songId = requireString(record.songId, "songId");
  if (typeof record.revision !== "number")
    throw new TypeError("revision must be a number");
  return projectArtifacts(songId, record.revision);
});

// Peaks of the instrumental for the karaoke waveform; computed here because the renderer never decodes audio.
ipcMain.handle(ipcChannels.waveformPeaks, (_event, raw: unknown) => {
  if (!raw || typeof raw !== "object") throw new TypeError("Waveform request must be an object");
  const record = raw as Record<string, unknown>;
  if (typeof record.revision !== "number" || typeof record.bins !== "number")
    throw new TypeError("revision and bins must be numbers");
  const { instrumental } = projectArtifacts(requireString(record.songId, "songId"), record.revision);
  return waveformPeaks(instrumental, record.bins);
});

ipcMain.handle(ipcChannels.revealProject, (_event, raw: unknown) => {
  if (!raw || typeof raw !== "object")
    throw new TypeError("Project request must be an object");
  const record = raw as Record<string, unknown>;
  const songId = requireString(record.songId, "songId");
  if (typeof record.revision !== "number")
    throw new TypeError("revision must be a number");
  shell.showItemInFolder(
    path.join(projectRevisionRoot(songId, record.revision), "manifest.json"),
  );
});
ipcMain.handle(ipcChannels.inspectWave, (_event, value: unknown) =>
  inspectWave(requireString(value, "path")),
);

const themeIconPath = (theme: string): string | null => {
  if (!isThemeName(theme)) return null;
  const candidate = path.join(projectRoot(), "frontend", "src", "assets", "theme-icons", `${theme}.png`);
  return fs.existsSync(candidate) ? candidate : null;
};

// The taskbar icon follows the active theme, like the icon inside the application.
ipcMain.handle(ipcChannels.setAppIcon, (_event, theme: unknown) => {
  const icon = typeof theme === "string" ? themeIconPath(theme) : null;
  if (!icon || !isThemeName(theme)) return;
  saveTheme(theme);
  mainWindow?.setIcon(icon);
});

// The renderer says when the first real screen (or an error screen) is ready to look at.
ipcMain.handle(ipcChannels.appReady, () => revealMainWindow());

// Generic scene video: visual fallback when a song has no video of its own (audio always comes from AudioService).
ipcMain.handle(ipcChannels.sceneVideoUrl, () => {
  const candidate = path.join(projectRoot(), "frontend", "media", "scene.webm");
  return fs.existsSync(candidate) ? pathToFileURL(candidate).toString() : null;
});
ipcMain.handle(ipcChannels.pickImageFile, async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png", "webp"] }],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});
ipcMain.handle(ipcChannels.statFile, (_event, value: unknown) => {
  const filePath = requireString(value, "path");
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) throw new Error("Not a file");
  return {
    name: path.basename(filePath),
    extension: path.extname(filePath).slice(1).toLowerCase(),
    sizeBytes: stats.size,
  };
});
ipcMain.handle(ipcChannels.toggleFullscreen, () => {
  if (!mainWindow) return false;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
  return mainWindow.isFullScreen();
});
ipcMain.handle(ipcChannels.isFullscreen, () => mainWindow?.isFullScreen() ?? false);
ipcMain.handle(ipcChannels.saveTextFile, async (_event, raw: unknown) => {
  if (!mainWindow || !raw || typeof raw !== "object") return false;
  const record = raw as Record<string, unknown>;
  const defaultName = path.basename(requireString(record.defaultName, "defaultName"));
  const content = requireString(record.content, "content");
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: [{ name: "Text", extensions: ["txt", "json"] }],
  });
  if (result.canceled || !result.filePath) return false;
  fs.writeFileSync(result.filePath, content, "utf8");
  return true;
});
ipcMain.handle(ipcChannels.openMicrophonePrivacy, async () => {
  await shell.openExternal("ms-settings:privacy-microphone");
});
ipcMain.handle(ipcChannels.confirmClose, () => {
  closeConfirmed = true;
  mainWindow?.close();
});
