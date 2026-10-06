import { app, BrowserWindow, clipboard, dialog, Menu, shell } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createTrustedIpc } from "./TrustedIpc";
import { pickSceneClip, registerSceneProtocol } from "./SceneProtocol";
import {
  loadWindowState,
  publishWindowState,
  saveWindowState,
} from "./WindowState";
import { panelWindowOpenHandler, securePanelWindow } from "./PanelWindows";
import {
  closeSplash,
  isThemeName,
  openSplash,
  readSavedTheme,
  saveTheme,
} from "./Splash";
import { sendAudioRequest, type AudioRequest } from "./AudioServiceTransport";
import {
  joinRoomVoice,
  leaveRoomVoice,
  roomServerRequest,
  roomServerApiBase,
  roomVoiceLevels,
  setRoomVoiceParticipantGain,
} from "./RoomServerTransport";
import { registerRoomProjectTransferHandlers } from "./RoomProjectTransfer";
import { registerProjectFileHandlers } from "./ProjectFiles";
import { registerSocialChannel } from "./SocialChannel";
import { withDevice } from "./SocialIdentity";
import { roomParticipantId } from "./RoomIdentity";
import { requireObject, requireString } from "./RequestValidation";
import { ipcChannels, roomParticipantArgument } from "./ipcChannels";
import { ServiceProcess } from "./ServiceProcess";
import { BackendEndpoint } from "./BackendEndpoint";
import { streamBackendEvents } from "./BackendEvents";
import { watchAppVisibility } from "./AppVisibility";
import { configureRuntimeIdentity } from "./RuntimeIdentity";
import {
  createKeyboardLightingProvider,
  type KeyboardLightingRequest,
} from "./KeyboardLighting";
import { launchAsio4AllInstaller } from "./Asio4AllInstaller";
const currentDir = __dirname;
configureRuntimeIdentity(app);
let mainWindow: BrowserWindow | null = null;
const rendererUrl =
  process.env.VITE_DEV_SERVER_URL ??
  pathToFileURL(path.join(currentDir, "../dist/index.html")).href;
const trustedIpc = createTrustedIpc(() => mainWindow, rendererUrl);
let pythonProcess: ServiceProcess | null = null;
const backendEndpoint = new BackendEndpoint();
const backendEventsStop = new AbortController();
let audioProcess: ServiceProcess | null = null;
let backendDataRoot = "";
const keyboardLighting = createKeyboardLightingProvider();
registerRoomProjectTransferHandlers(
  roomServerApiBase,
  () => backendDataRoot,
  trustedIpc,
);
registerProjectFileHandlers(() => backendDataRoot, backendEndpoint, trustedIpc);
const socialSocket = registerSocialChannel(
  roomServerApiBase,
  () => mainWindow,
  trustedIpc,
);
let closeConfirmed = false;
const requireSafeExternalUrl = (value: unknown): string => {
  const rawUrl = requireString(value, "url");
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("Unsupported external URL protocol");
  }
  return url.toString();
};
const storageRootFile = (): string =>
  path.join(app.getPath("userData"), "storage-root.txt");
const configuredStorageRoot = (): string => {
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
const projectRoot = (): string =>
  app.isPackaged ? process.resourcesPath : path.resolve(currentDir, "..", "..");
const pythonRoot = (): string =>
  app.isPackaged
    ? path.join(process.resourcesPath, "python-app")
    : path.join(projectRoot(), "python");
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
const startServices = (): void => {
  backendDataRoot = configuredStorageRoot();
  const environmentRoot = path.join(backendDataRoot, "environment");
  const projectEnvironmentFile =
    process.env.AD_VOICE_PROJECT_ENV_FILE ??
    (app.isPackaged ? path.join(environmentRoot, "project.env") : undefined);
  const pythonEnvironmentFile =
    process.env.AD_VOICE_ENV_FILE ??
    (app.isPackaged ? path.join(environmentRoot, "python.env") : undefined);
  const frontendEnvironmentFile =
    process.env.AD_VOICE_FRONTEND_ENV_FILE ??
    (app.isPackaged ? path.join(environmentRoot, "frontend.env") : undefined);
  const environmentSeeds = app.isPackaged
    ? [
        {
          source: path.join(
            process.resourcesPath,
            "local-secrets",
            "env",
            "project.env",
          ),
          target: projectEnvironmentFile,
        },
        {
          source: path.join(pythonRoot(), ".env"),
          target: pythonEnvironmentFile,
        },
        {
          source: path.join(process.resourcesPath, "frontend", ".env.local"),
          target: frontendEnvironmentFile,
        },
      ]
    : [];
  for (const seed of environmentSeeds) {
    if (
      !seed.target ||
      fs.existsSync(seed.target) ||
      !fs.existsSync(seed.source)
    )
      continue;
    fs.mkdirSync(path.dirname(seed.target), { recursive: true });
    fs.copyFileSync(seed.source, seed.target, fs.constants.COPYFILE_EXCL);
  }
  const venvPython = path.join(pythonRoot(), ".venv", "Scripts", "python.exe");
  const bundledPython = path.join(
    process.resourcesPath,
    "python-runtime",
    "python.exe",
  );
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
      AD_VOICE_PROJECT_ENV_FILE: projectEnvironmentFile,
      AD_VOICE_ENV_FILE: pythonEnvironmentFile,
      AD_VOICE_FRONTEND_ENV_FILE: frontendEnvironmentFile,
      AD_VOICE_KAGGLE_ASSETS: path.join(projectRoot(), "kaggle"),
      PYTHONPATH: app.isPackaged ? pythonRoot() : process.env.PYTHONPATH,
      PATH: executablePath,
    },
    backendEndpoint,
  );
  pythonProcess.start();

  const executable = audioExecutable();
  if (fs.existsSync(executable)) {
    audioProcess = new ServiceProcess(
      executable,
      [],
      path.dirname(executable),
      process.env,
    );
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
    python?.stop(async () => {
      python.endInput();
    }),
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

let windowRoomParticipant = "";

const createWindow = (): void => {
  const state = loadWindowState();
  const window = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    frame: false,
    backgroundColor: "#101114",
    show: false,
    icon: themeIconPath(readSavedTheme()) ?? undefined,
    webPreferences: {
      preload: path.join(currentDir, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Panels moved into their own windows (room, console, piano roll) are drawn by this window's
      // timers; they must keep running while this window is minimised or covered.
      backgroundThrottling: false,
      additionalArguments: [
        `${roomParticipantArgument}${windowRoomParticipant}`,
      ],
    },
  });
  mainWindow = window;
  if (state.maximized) window.maximize();

  // A renderer that crashed or hangs cannot answer the close request below; without this the
  // window could then only be ended from the Task Manager.
  let rendererUnavailable = false;
  let lastRendererReload = 0;
  window.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    rendererUnavailable = true;
    console.error(`Renderer process gone: ${details.reason}`);
    // One reload brings the app back; a renderer that keeps crashing is not reloaded in a loop.
    if (Date.now() - lastRendererReload < 10_000) return;
    lastRendererReload = Date.now();
    window.webContents.reload();
  });
  window.webContents.on("did-finish-load", () => {
    rendererUnavailable = false;
  });
  window.on("unresponsive", () => {
    rendererUnavailable = true;
  });
  window.on("responsive", () => {
    rendererUnavailable = false;
  });

  // The renderer decides whether the window may close (unsaved edits, recording, room, processing).
  window.on("close", (event) => {
    saveWindowState(window);
    if (closeConfirmed || rendererUnavailable) return;
    event.preventDefault();
    window.webContents.send(ipcChannels.closeRequested);
  });
  const publish = (): void => publishWindowState(window);
  window.on("maximize", publish);
  window.on("unmaximize", publish);
  window.on("minimize", publish);
  window.on("restore", publish);
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
  window.webContents.on("will-frame-navigate", (event) => {
    const localBackdrop = !event.isMainFrame && event.url === "about:srcdoc";
    if (!localBackdrop && !trustedIpc.isRendererUrl(event.url))
      event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!trustedIpc.isRendererUrl(url)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(
    panelWindowOpenHandler(themeIconPath(readSavedTheme()) ?? undefined),
  );
  const visibility = watchAppVisibility(window, (onScreen) => {
    if (!window.isDestroyed())
      window.webContents.send(ipcChannels.appVisibility, onScreen);
  });
  window.webContents.on("did-finish-load", () => visibility.republish());
  window.webContents.on("did-create-window", (panel) => {
    securePanelWindow(panel);
    visibility.addPanel(panel);
  });
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
  const request = requireObject(value, "request");
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

// One instance owns the services and the audio pipe; a second launch must not kill them, it only focuses the window.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();
app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  // The windows are frameless and draw their own controls; a released app also drops the default
  // menu's hidden shortcuts (developer tools, reload) that would otherwise still respond to keys.
  if (app.isPackaged) Menu.setApplicationMenu(null);
  if (!isPrimaryInstance) return;
  registerSceneProtocol(projectRoot());
  startServices();
  socialSocket.start();
  streamBackendEvents(
    backendEndpoint,
    (event) => mainWindow?.webContents.send(ipcChannels.backendEvent, event),
    backendEventsStop.signal,
  );
  openSplash(
    themeIconPath(readSavedTheme()),
    path.join(currentDir, "..", "electron", "splash.html"),
  );
  windowRoomParticipant = await roomParticipantId();
  createWindow();
  setTimeout(revealMainWindow, splashFallbackMilliseconds).unref();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error: unknown) => {
  // Without this a failed start left an invisible process: no splash, no window, no message.
  console.error("Application startup failed", error);
  closeSplash();
  const language = app.getLocale().slice(0, 2);
  const headline =
    language === "ru" ? "Не удалось запустить приложение."
    : language === "uk" ? "Не вдалося запустити застосунок."
    : "The application could not start.";
  dialog.showErrorBox(
    "A&D Voice",
    `${headline}

${error instanceof Error ? error.message : String(error)}`,
  );
  app.quit();
});

let servicesStopped = false;
let servicesStopping: Promise<void> | null = null;
const stopServicesOnce = (): void => {
  closeSplash();
  socialSocket.stop();
  backendEventsStop.abort();
  if (servicesStopped || !isPrimaryInstance) return;
  servicesStopped = true;
  stopServices();
};
app.on("before-quit", (event) => {
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
trustedIpc.handle(
  ipcChannels.getStorageRoot,
  () => backendDataRoot || configuredStorageRoot(),
);
trustedIpc.handle(
  ipcChannels.pickStorageFolder,
  async (_event, current: unknown) => {
    if (!mainWindow) return null;
    const requested =
      typeof current === "string" && path.isAbsolute(current)
        ? current
        : backendDataRoot || configuredStorageRoot();
    const result = await dialog.showOpenDialog(mainWindow, {
      defaultPath: requested,
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  },
);
trustedIpc.handle(ipcChannels.setStorageRoot, (_event, raw: unknown) => {
  const next = requireString(raw, "path").trim();
  if (!path.isAbsolute(next))
    throw new TypeError("Storage path must be absolute");
  fs.mkdirSync(next, { recursive: true });
  fs.writeFileSync(storageRootFile(), next, "utf8");
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
      body:
        request.body === undefined ? undefined : JSON.stringify(request.body),
    });
  } catch (error) {
    // A backend that is still starting or restarting is an expected state, reported as data instead of an IPC failure.
    const message =
      error instanceof Error ? error.message : "Python backend is unreachable";
    return {
      status: 503,
      ok: false,
      body: { code: "BackendUnavailable", message },
    };
  }
});
trustedIpc.handle(ipcChannels.roomRequest, async (_event, raw: unknown) =>
  roomServerRequest(await withDevice(requirePythonRequest(raw))),
);
trustedIpc.handle(ipcChannels.joinRoomVoice, async (_event, raw: unknown) => {
  const identity = requireObject(raw, "voice identity");
  return joinRoomVoice(
    requireString(identity.roomId, "roomId"),
    requireString(identity.participantId, "participantId"),
  );
});
trustedIpc.handle(ipcChannels.leaveRoomVoice, async () => leaveRoomVoice());
trustedIpc.handle(ipcChannels.roomVoiceLevels, async () => roomVoiceLevels());
trustedIpc.handle(
  ipcChannels.setRoomVoiceParticipantGain,
  async (_event, raw: unknown) => {
    const value = requireObject(raw, "participant gain");
    const gain = Number(value.gain);
    if (!Number.isFinite(gain)) throw new TypeError("gain must be a number");
    await setRoomVoiceParticipantGain(
      requireString(value.participantId, "participantId"),
      gain,
    );
  },
);
trustedIpc.handle(
  ipcChannels.keyboardLightingCapabilities,
  async () =>
    keyboardLighting?.capabilities() ?? { available: false, deviceCount: 0 },
);
trustedIpc.handle(
  ipcChannels.setKeyboardLighting,
  async (_event, raw: unknown) => {
    const value = requireObject(raw, "lighting request");
    if (
      typeof value.enabled !== "boolean" ||
      typeof value.brightness !== "number" ||
      typeof value.color !== "string"
    ) {
      throw new TypeError("invalid lighting request");
    }
    await keyboardLighting?.apply(value as unknown as KeyboardLightingRequest);
  },
);
trustedIpc.handle(ipcChannels.audioRequest, async (_event, raw: unknown) => {
  const record = requireObject(raw, "Audio request");
  const command = requireString(record.command, "command");
  const args =
    record.args && typeof record.args === "object"
      ? (record.args as AudioRequest["args"])
      : undefined;
  try {
    return await sendAudioRequest({ command, args });
  } catch (error) {
    // The pipe does not exist until AudioService has finished starting; report that as an ordinary failed response.
    const message =
      error instanceof Error ? error.message : "AudioService is unreachable";
    return { status: -1, text: `AudioService unavailable: ${message}` };
  }
});
const themeIconPath = (theme: string): string | null => {
  if (!isThemeName(theme)) return null;
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, "theme-icons", `${theme}.png`)
    : path.join(
        projectRoot(),
        "frontend",
        "src",
        "assets",
        "theme-icons",
        `${theme}.png`,
      );
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

trustedIpc.handle(ipcChannels.sceneVideoUrl, () =>
  pickSceneClip(projectRoot()),
);
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
trustedIpc.handle(
  ipcChannels.isFullscreen,
  () => mainWindow?.isFullScreen() ?? false,
);
trustedIpc.handle(ipcChannels.saveTextFile, async (_event, raw: unknown) => {
  if (!mainWindow || !raw || typeof raw !== "object") return false;
  const record = raw as Record<string, unknown>;
  const defaultName = path.basename(
    requireString(record.defaultName, "defaultName"),
  );
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
trustedIpc.handle(ipcChannels.installAsio4All, async () => {
  if (process.platform !== "win32")
    throw new Error("ASIO4ALL is available only on Windows");
  await launchAsio4AllInstaller(
    path.join(app.getPath("temp"), "ad-voice-asio4all"),
    (target) => shell.openPath(target),
  );
});
trustedIpc.handle(ipcChannels.relaunchApp, () => {
  app.relaunch();
  app.exit(0);
});
trustedIpc.handle(ipcChannels.confirmClose, () => {
  closeConfirmed = true;
  mainWindow?.close();
});
