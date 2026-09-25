import { app, BrowserWindow, clipboard, dialog, shell } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createTrustedIpc } from "./TrustedIpc";
import { isSafePathComponent } from "./PathPolicy";
import { pickSceneClip, registerSceneProtocol } from "./SceneProtocol";
import { waveformPeaks } from "./WavPeaks";
import { inspectWave } from "./WavFile";
import { loadWindowState, minWindowHeight, minWindowWidth, publishWindowState, saveWindowState } from "./WindowState";
import { closeSplash, isThemeName, openSplash, readSavedTheme, saveTheme } from "./Splash";
import { sendAudioRequest, type AudioRequest } from "./AudioServiceTransport";
import { joinRoomVoice, leaveRoomVoice, roomServerRequest, roomServerApiBase } from "./RoomServerTransport";
import { registerRoomProjectTransferHandlers } from "./RoomProjectTransfer";
import { ipcChannels } from "./ipcChannels";
import { ServiceProcess } from "./ServiceProcess";
import { BackendEndpoint } from "./BackendEndpoint";
import { configureRuntimeIdentity } from "./RuntimeIdentity";
import { createKeyboardLightingProvider, type KeyboardLightingRequest } from "./KeyboardLighting";
const currentDir = __dirname;
configureRuntimeIdentity(app);
let mainWindow: BrowserWindow | null = null;
const rendererUrl = process.env.VITE_DEV_SERVER_URL ?? pathToFileURL(path.join(currentDir, "../dist/index.html")).href;
const trustedIpc = createTrustedIpc(() => mainWindow, rendererUrl);
let pythonProcess: ServiceProcess | null = null;
const backendEndpoint = new BackendEndpoint();
let audioProcess: ServiceProcess | null = null;
let backendDataRoot = "";
const keyboardLighting = createKeyboardLightingProvider();
registerRoomProjectTransferHandlers(roomServerApiBase, () => backendDataRoot, trustedIpc);
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
const projectRoot = (): string => app.isPackaged
  ? process.resourcesPath
  : path.resolve(currentDir, "..", "..");
const pythonRoot = (): string =>
  app.isPackaged
    ? path.join(process.resourcesPath, "python-app")
    : path.join(projectRoot(), "python");
const audioExecutable = (): string => {
  const configured = process.env.AD_VOICE_AUDIO_SERVICE;
  if (configured) return configured;
  const names = process.platform === "win32" ? ["AudioService.exe"] : ["AudioService"];
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
const startServices = (): void => {
  backendDataRoot =
    process.env.AD_VOICE_DATA ??
    path.join(app.getPath("userData"), "backend-data");
  const venvPython = path.join(pythonRoot(), ".venv", "Scripts", "python.exe");
  const bundledPython = path.join(process.resourcesPath, "python-runtime", "python.exe");
  const python =
    process.env.AD_VOICE_PYTHON ??
    (app.isPackaged
      ? bundledPython
      : fs.existsSync(venvPython)
        ? venvPython
        : process.platform === "win32"
          ? "python"
          : "python3");
  const bundledTools = path.join(process.resourcesPath, "tools");
  const executablePath = app.isPackaged
    ? `${bundledTools}${path.delimiter}${process.env.PATH ?? ""}`
    : process.env.PATH;
  pythonProcess = new ServiceProcess(
    python,
    ["-m", "backend.main"],
    pythonRoot(),
    {
      ...process.env,
      AD_VOICE_DATA: backendDataRoot,
      AD_VOICE_PORT: process.env.AD_VOICE_PORT ?? "0",
      AD_VOICE_MANAGED: "1",
      AD_VOICE_ENV_FILE: process.env.AD_VOICE_ENV_FILE ?? (app.isPackaged ? path.join(pythonRoot(), ".env") : undefined),
      PYTHONPATH: app.isPackaged ? pythonRoot() : process.env.PYTHONPATH,
      PATH: executablePath,
    },
    backendEndpoint,
  );
  pythonProcess.start();

  const executable = audioExecutable();
  if (fs.existsSync(executable)) {
    audioProcess = new ServiceProcess(executable, [], path.dirname(executable), process.env);
    audioProcess.start();
  } else {
    console.warn(`AudioService executable not found: ${executable}`);
  }
};

const stopServices = (): void => {
  const processes = [audioProcess, pythonProcess];
  audioProcess = null;
  pythonProcess = null;
  for (const service of processes) void service?.stop();
};

const stopServicesGracefully = async (): Promise<void> => {
  const audio = audioProcess;
  const python = pythonProcess;
  await Promise.allSettled([
    audio?.stop(() => sendAudioRequest({ command: "ShutdownService" })),
    python?.stop(async () => { python.endInput(); }),
    audio ? leaveRoomVoice() : Promise.resolve(),
  ]);
  if (audioProcess === audio) audioProcess = null;
  if (pythonProcess === python) pythonProcess = null;
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

  window.webContents.on("will-navigate", (event, url) => {
    if (!trustedIpc.isRendererUrl(url)) event.preventDefault();
  });
  window.webContents.on("will-frame-navigate", event => {
    const localBackdrop = !event.isMainFrame && event.url === "about:srcdoc";
    if (!localBackdrop && !trustedIpc.isRendererUrl(event.url)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!trustedIpc.isRendererUrl(url)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  void window.loadURL(rendererUrl);
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
    !isSafePathComponent(songId) ||
    !Number.isSafeInteger(revision) ||
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

const projectArtifacts = (
  songId: string,
  revision: number,
): { instrumental: string; vocals?: string; melody?: string; lyricsSync?: string } => {
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
    melody: byName.get("melody"),
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
  registerSceneProtocol(projectRoot());
  startServices();
  openSplash(themeIconPath(readSavedTheme()), path.join(currentDir, "..", "electron", "splash.html"));
  createWindow();
  setTimeout(revealMainWindow, splashFallbackMilliseconds).unref();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let servicesStopped = false;
let servicesStopping: Promise<void> | null = null;
const stopServicesOnce = (): void => {
  closeSplash();
  if (servicesStopped || !isPrimaryInstance) return;
  servicesStopped = true;
  stopServices();
};
app.on("before-quit", event => {
  if (servicesStopped || !isPrimaryInstance) return;
  event.preventDefault();
  if (mainWindow && !mainWindow.isDestroyed() && !closeConfirmed) {
    mainWindow.close();
    return;
  }
  closeSplash();
  servicesStopping ??= stopServicesGracefully().finally(() => {
    servicesStopped = true;
    app.quit();
  });
});
app.on("will-quit", stopServicesOnce);
process.on("exit", stopServicesOnce);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

trustedIpc.handle(ipcChannels.minimize, () => mainWindow?.minimize());
trustedIpc.handle(ipcChannels.toggleMaximize, () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return mainWindow.isMaximized();
});
trustedIpc.handle(ipcChannels.close, () => mainWindow?.close());
trustedIpc.handle(
  ipcChannels.isMaximized,
  () => mainWindow?.isMaximized() ?? false,
);
trustedIpc.handle(ipcChannels.pickAudioFile, async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [
      { name: "Audio", extensions: ["mp3", "wav", "flac", "m4a", "ogg"] },
    ],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});
trustedIpc.handle(ipcChannels.reveal, (_event, targetPath: unknown) => {
  shell.showItemInFolder(requireString(targetPath, "path"));
});
trustedIpc.handle(ipcChannels.openExternal, async (_event, value: unknown) => {
  await shell.openExternal(requireSafeExternalUrl(value));
});
trustedIpc.handle(ipcChannels.copyText, (_event, value: unknown) => {
  clipboard.writeText(requireString(value, "text"));
});
trustedIpc.handle(ipcChannels.pythonRequest, async (_event, raw: unknown) => {
  const request = requirePythonRequest(raw);
  try {
    return await backendEndpoint.request(request.path, {
      method: request.method,
      headers: { "Content-Type": "application/json", ...request.headers },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });
  } catch (error) {
    // A backend that is still starting or restarting is an expected state, reported as data instead of an IPC failure.
    const message = error instanceof Error ? error.message : "Python backend is unreachable";
    return { status: 503, ok: false, body: { code: "BackendUnavailable", message } };
  }
});
trustedIpc.handle(ipcChannels.roomRequest, async (_event, raw: unknown) =>
  roomServerRequest(requirePythonRequest(raw)));
trustedIpc.handle(ipcChannels.joinRoomVoice, async (_event, raw: unknown) => {
  if (!raw || typeof raw !== "object") throw new TypeError("voice identity must be an object");
  const identity = raw as Record<string, unknown>;
  return joinRoomVoice(
    requireString(identity.roomId, "roomId"),
    requireString(identity.participantId, "participantId"),
  );
});
trustedIpc.handle(ipcChannels.leaveRoomVoice, async () => leaveRoomVoice());
trustedIpc.handle(ipcChannels.keyboardLightingCapabilities, async () =>
  keyboardLighting?.capabilities() ?? { available: false, deviceCount: 0 },
);
trustedIpc.handle(ipcChannels.setKeyboardLighting, async (_event, raw: unknown) => {
  if (!raw || typeof raw !== "object") throw new TypeError("lighting request must be an object");
  const value = raw as Record<string, unknown>;
  if (typeof value.enabled !== "boolean" || typeof value.brightness !== "number" || typeof value.color !== "string") {
    throw new TypeError("invalid lighting request");
  }
  await keyboardLighting?.apply(value as unknown as KeyboardLightingRequest);
});
trustedIpc.handle(ipcChannels.audioRequest, async (_event, raw: unknown) => {
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
trustedIpc.handle(ipcChannels.resolveProjectArtifacts, (_event, raw: unknown) => {
  if (!raw || typeof raw !== "object")
    throw new TypeError("Project request must be an object");
  const record = raw as Record<string, unknown>;
  const songId = requireString(record.songId, "songId");
  if (typeof record.revision !== "number")
    throw new TypeError("revision must be a number");
  return projectArtifacts(songId, record.revision);
});

// Peaks of the instrumental for the karaoke waveform; computed here because the renderer never decodes audio.
trustedIpc.handle(ipcChannels.waveformPeaks, (_event, raw: unknown) => {
  if (!raw || typeof raw !== "object") throw new TypeError("Waveform request must be an object");
  const record = raw as Record<string, unknown>;
  if (typeof record.revision !== "number" || typeof record.bins !== "number")
    throw new TypeError("revision and bins must be numbers");
  const { instrumental } = projectArtifacts(requireString(record.songId, "songId"), record.revision);
  return waveformPeaks(instrumental, record.bins);
});

// Peaks of a saved take: the backend names the file, so the renderer never passes a path.
trustedIpc.handle(ipcChannels.recordingPeaks, async (_event, raw: unknown) => {
  if (!raw || typeof raw !== "object") throw new TypeError("Recording request must be an object");
  const record = raw as Record<string, unknown>;
  if (typeof record.bins !== "number") throw new TypeError("bins must be a number");
  const response = await backendEndpoint.request(`/recordings/${encodeURIComponent(requireString(record.recordingId, "recordingId"))}`);
  if (!response.ok) throw new Error(`Recording lookup failed: HTTP ${response.status}`);
  const { filePath } = response.body as { filePath?: unknown };
  return waveformPeaks(requireString(filePath, "filePath"), record.bins);
});

trustedIpc.handle(ipcChannels.revealProject, (_event, raw: unknown) => {
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
trustedIpc.handle(ipcChannels.inspectWave, (_event, value: unknown) =>
  inspectWave(requireString(value, "path")),
);

const themeIconPath = (theme: string): string | null => {
  if (!isThemeName(theme)) return null;
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, "theme-icons", `${theme}.png`)
    : path.join(projectRoot(), "frontend", "src", "assets", "theme-icons", `${theme}.png`);
  return fs.existsSync(candidate) ? candidate : null;
};

// The taskbar icon follows the active theme, like the icon inside the application.
trustedIpc.handle(ipcChannels.setAppIcon, (_event, theme: unknown) => {
  const icon = typeof theme === "string" ? themeIconPath(theme) : null;
  if (!icon || !isThemeName(theme)) return;
  saveTheme(theme);
  mainWindow?.setIcon(icon);
});

// The renderer says when the first real screen (or an error screen) is ready to look at.
trustedIpc.handle(ipcChannels.appReady, () => revealMainWindow());

trustedIpc.handle(ipcChannels.sceneVideoUrl, () => pickSceneClip(projectRoot()));
trustedIpc.handle(ipcChannels.pickImageFile, async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png", "webp"] }],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});
trustedIpc.handle(ipcChannels.statFile, (_event, value: unknown) => {
  const filePath = requireString(value, "path");
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) throw new Error("Not a file");
  return {
    name: path.basename(filePath),
    extension: path.extname(filePath).slice(1).toLowerCase(),
    sizeBytes: stats.size,
  };
});
trustedIpc.handle(ipcChannels.toggleFullscreen, () => {
  if (!mainWindow) return false;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
  return mainWindow.isFullScreen();
});
trustedIpc.handle(ipcChannels.isFullscreen, () => mainWindow?.isFullScreen() ?? false);
trustedIpc.handle(ipcChannels.saveTextFile, async (_event, raw: unknown) => {
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
trustedIpc.handle(ipcChannels.openMicrophonePrivacy, async () => {
  await shell.openExternal("ms-settings:privacy-microphone");
});
trustedIpc.handle(ipcChannels.confirmClose, () => {
  closeConfirmed = true;
  mainWindow?.close();
});
