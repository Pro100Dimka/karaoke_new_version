import { app, BrowserWindow, dialog, Menu } from "electron";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { configuredStorageRoot, projectRoot, themeIconPath } from "./AppPaths";
import { AppLogUploader, sendAppLogs } from "./AppLogUploader";
import { BackendEndpoint } from "./BackendEndpoint";
import { streamBackendEvents } from "./BackendEvents";
import { registerDesktopIpc } from "./DesktopIpc";
import { ipcChannels } from "./ipcChannels";
import { createKeyboardLightingProvider } from "./KeyboardLighting";
import { createMainWindow } from "./MainWindow";
import { ManagedServices } from "./ManagedServices";
import { registerProjectFileHandlers } from "./ProjectFiles";
import { roomParticipantId } from "./RoomIdentity";
import { registerRoomProjectTransferHandlers } from "./RoomProjectTransfer";
import { roomServerApiBase } from "./RoomServerTransport";
import { configureRuntimeIdentity } from "./RuntimeIdentity";
import { registerSceneProtocol } from "./SceneProtocol";
import { registerServiceIpc } from "./ServiceIpc";
import { registerSocialChannel } from "./SocialChannel";
import { closeSplash, openSplash, readSavedTheme } from "./Splash";
import { createTrustedIpc } from "./TrustedIpc";

// Hybrid Windows laptops otherwise keep Chromium's compositor and WebGL work on the integrated GPU.
app.commandLine.appendSwitch("force-high-performance-gpu");
configureRuntimeIdentity(app);

/** The splash gives way to the window even if the renderer never reports its first screen. */
const splashFallbackMilliseconds = 90_000;
const rendererUrl =
  process.env.VITE_DEV_SERVER_URL ?? pathToFileURL(path.join(__dirname, "../dist/index.html")).href;

let mainWindow: BrowserWindow | null = null;
let mainRevealed = false;
let closeConfirmed = false;
let backendDataRoot = "";

const trustedIpc = createTrustedIpc(() => mainWindow, rendererUrl);
const backendEndpoint = new BackendEndpoint();
const backendEventsStop = new AbortController();
const appLogs = new AppLogUploader(sendAppLogs);
appLogs.captureConsole(console);
const services = new ManagedServices(backendEndpoint, (source, level, data) =>
  appLogs.write(source, level, data),
);
const storageRoot = () => backendDataRoot || configuredStorageRoot();

registerRoomProjectTransferHandlers(roomServerApiBase, () => backendDataRoot, trustedIpc);
registerProjectFileHandlers(() => backendDataRoot, backendEndpoint, trustedIpc);
const socialSocket = registerSocialChannel(roomServerApiBase, () => mainWindow, trustedIpc);

/** Swaps the splash for the main window; safe to call repeatedly. */
const revealMainWindow = (): void => {
  if (mainRevealed) return;
  mainRevealed = true;
  mainWindow?.show();
  closeSplash();
};

const openMainWindow = (roomParticipant: string): void => {
  const window = createMainWindow({
    rendererUrl,
    trustedIpc,
    roomParticipant,
    log: (source, level, message) => appLogs.add(source, level, message),
    closeConfirmed: () => closeConfirmed,
    reveal: revealMainWindow,
  });
  mainWindow = window;
  window.on("closed", () => {
    mainWindow = null;
  });
};

registerDesktopIpc({
  trustedIpc,
  window: () => mainWindow,
  storageRoot,
  reveal: revealMainWindow,
  confirmClose: () => {
    closeConfirmed = true;
    mainWindow?.close();
  },
});
registerServiceIpc(trustedIpc, backendEndpoint, createKeyboardLightingProvider());

// One instance owns the services and the audio pipe; a second launch must not kill them, it only focuses the window.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();
app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

const startupFailed: Readonly<Record<string, string>> = {
  ru: "Не удалось запустить приложение.",
  uk: "Не вдалося запустити застосунок.",
};

app
  .whenReady()
  .then(async () => {
    // The windows are frameless and draw their own controls; a released app also drops the default
    // menu's hidden shortcuts (developer tools, reload) that would otherwise still respond to keys.
    if (app.isPackaged) Menu.setApplicationMenu(null);
    if (!isPrimaryInstance) return;
    registerSceneProtocol(projectRoot());
    backendDataRoot = configuredStorageRoot();
    services.start(backendDataRoot);
    appLogs.start();
    socialSocket.start();
    streamBackendEvents(
      backendEndpoint,
      (event) => mainWindow?.webContents.send(ipcChannels.backendEvent, event),
      backendEventsStop.signal,
    );
    openSplash(themeIconPath(readSavedTheme()), path.join(__dirname, "..", "electron", "splash.html"));
    const roomParticipant = await roomParticipantId();
    openMainWindow(roomParticipant);
    setTimeout(revealMainWindow, splashFallbackMilliseconds).unref();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) openMainWindow(roomParticipant);
    });
  })
  .catch((error: unknown) => {
    // Without this a failed start left an invisible process: no splash, no window, no message.
    console.error("Application startup failed", error);
    closeSplash();
    const headline =
      startupFailed[app.getLocale().slice(0, 2)] ?? "The application could not start.";
    const detail = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox("A&D Voice", `${headline}\n\n${detail}`);
    app.quit();
  });

let servicesStopped = false;
let servicesStopping: Promise<void> | null = null;

const stopServicesOnce = (): void => {
  closeSplash();
  void appLogs.stop();
  socialSocket.stop();
  backendEventsStop.abort();
  if (servicesStopped || !isPrimaryInstance) return;
  servicesStopped = true;
  services.stop();
};

app.on("before-quit", (event) => {
  if (servicesStopped || !isPrimaryInstance) return;
  event.preventDefault();
  if (mainWindow && !mainWindow.isDestroyed() && !closeConfirmed) {
    mainWindow.close();
    return;
  }
  closeSplash();
  servicesStopping ??= services.stopGracefully().finally(async () => {
    // A short final upload captures service shutdown errors without making offline exit wait for HTTP timeout.
    await Promise.race([
      appLogs.stop(),
      new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
    ]);
    servicesStopped = true;
    app.quit();
  });
});
app.on("will-quit", stopServicesOnce);
process.on("exit", stopServicesOnce);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
