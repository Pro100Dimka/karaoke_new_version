import { app, BrowserWindow, dialog, Menu } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnvFile } from "node:process";
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
import { closeSplash, openSplash, readSavedTheme, setSplashStatus, waitForStorageMigration } from "./Splash";
import { shellLanguages, shellText } from "./ShellText";
import { createTrustedIpc } from "./TrustedIpc";
import { applyGpuSwitches } from "./GpuSwitches";
import { startAutoUpdate } from "./AutoUpdate";
import { startRadioNowPlaying } from "./RadioNowPlaying";
import { startDesktopLaunch } from "./DesktopLaunch";
import { DesktopShell } from "./DesktopShell";
import { startDiscordPresence } from "./DiscordPresence";
import { createShellNotifier, registerShellIpc } from "./ShellIpc";
import { createTaskbarIntegration } from "./TaskbarIntegration";
import { createTrayRadio } from "./TrayRadio";
import { configureNotificationIdentity } from "./NotificationIdentity";

const startupFailed: Readonly<Record<string, string>> = {
  ru: "Не удалось запустить приложение.",
  uk: "Не вдалося запустити застосунок.",
};

const showStartupError = (error: unknown): void => {
  console.error("Application startup failed", error);
  const locale = app.isReady() ? app.getLocale().slice(0, 2) : "en";
  const headline = startupFailed[locale] ?? "The application could not start.";
  const detail = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox("A&D Voice", `${headline}\n\n${detail}`);
};

if (!app.isPackaged) {
  try {
    loadEnvFile(path.join(app.getAppPath(), ".env.local"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
applyGpuSwitches(app.commandLine);
try {
  configureRuntimeIdentity(app);
} catch (error) {
  try {
    showStartupError(error);
  } finally {
    app.exit(1);
  }
}
// Notifications say "A&D Voice" (not "Electron") with the app's icon; each profile has its own id.
configureNotificationIdentity(app, themeIconPath(readSavedTheme()));

/** The splash gives way to the window even if the renderer never reports its first screen. */
const splashFallbackMilliseconds = 90_000;
const rendererUrl =
  process.env.VITE_DEV_SERVER_URL ?? pathToFileURL(path.join(__dirname, "../dist/index.html")).href;

let mainWindow: BrowserWindow | null = null;
let mainRevealed = false;
let closeConfirmed = false;
let backendDataRoot = "";
/** Set when the app starts to quit: closing the window then really closes it (no hiding to the tray). */
let quitting = false;

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

// The desktop shell: taskbar, tray, jump list, invitation links, mute hotkey, Discord and updates.
const shell = new DesktopShell();
const notify = createShellNotifier(() => mainWindow, themeIconPath(readSavedTheme()) ?? undefined);
registerShellIpc(trustedIpc, shell, () => mainWindow, notify);
const taskbar = createTaskbarIntegration({ window: () => mainWindow, shell, notify });
const trayRadio = createTrayRadio({
  window: () => mainWindow,
  shell,
  iconPath: () => themeIconPath(readSavedTheme()),
  notify,
  quit: () => app.quit(),
  // An exit the user already confirmed (or a quit in progress) really closes.
  quitting: () => quitting || closeConfirmed,
});
// Whether updates install by themselves is needed before the interface has loaded (the check before
// launch), so the interface's setting is kept in a file too.
const updateSettingsFile = () => path.join(app.getPath("userData"), "update-settings.json");
const readAutoUpdate = (): boolean => {
  try {
    return (JSON.parse(fs.readFileSync(updateSettingsFile(), "utf8")) as { automatic?: unknown }).automatic !== false;
  } catch {
    return true;
  }
};
let savedAutoUpdate: boolean | undefined;
shell.onStatus((next) => {
  savedAutoUpdate ??= readAutoUpdate();
  if (next.autoUpdate === savedAutoUpdate) return;
  savedAutoUpdate = next.autoUpdate;
  try {
    fs.writeFileSync(updateSettingsFile(), JSON.stringify({ automatic: next.autoUpdate }));
  } catch {
    // Only the next start's choice depends on it.
  }
});
const updater = startAutoUpdate({
  ready: (version) => shell.send({ type: "updateReady", version }),
  automatic: readAutoUpdate,
  available: (version) => shell.send({ type: "updateAvailable", version }),
  progress: (percent) => shell.send({ type: "updateProgress", percent }),
  installFailed: () => shell.send({ type: "updateFailed" }),
  log: (level, message) => appLogs.add("updater", level, message),
  quit: () => app.quit(),
});
trustedIpc.handle(ipcChannels.installUpdate, () => updater.install());
let desktopLaunch: ReturnType<typeof startDesktopLaunch> | null = null;
let discord: ReturnType<typeof startDiscordPresence> | null = null;
const radioNowPlaying = startRadioNowPlaying(shell);

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
    closeToTray: () => trayRadio.closeToTray(),
    reveal: revealMainWindow,
  });
  mainWindow = window;
  // Windows takes thumbnail buttons only from a visible window.
  window.on("show", () => taskbar.refresh());
  window.on("closed", () => {
    mainWindow = null;
  });
};

registerDesktopIpc({
  trustedIpc,
  window: () => mainWindow,
  storageRoot,
  reveal: revealMainWindow,
  confirmClose: (allowed) => {
    if (!allowed) {
      quitting = false;
      updater.cancelInstall();
      return;
    }
    closeConfirmed = true;
    mainWindow?.close();
  },
});
registerServiceIpc(trustedIpc, backendEndpoint, createKeyboardLightingProvider());

// One instance owns the services and the audio pipe; a second launch must not kill them, it only focuses the window.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();
app.on("second-instance", (_event, argv) => {
  // A second launch hands over what it was started for: an invitation link, a task, opened files.
  desktopLaunch?.secondLaunch(argv);
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  // The window may be hidden in the tray while the radio plays.
  mainWindow.show();
  mainWindow.focus();
});

app
  .whenReady()
  .then(async () => {
    // The windows are frameless and draw their own controls; a released app also drops the default
    // menu's hidden shortcuts (developer tools, reload) that would otherwise still respond to keys.
    if (app.isPackaged) Menu.setApplicationMenu(null);
    if (!isPrimaryInstance) return;
    openSplash(themeIconPath(readSavedTheme()), path.join(__dirname, "..", "electron", "splash.html"));
    // As in Discord: a newer version is installed before the app opens; offline it simply opens.
    const locale = app.getLocale().slice(0, 2);
    const language = shellLanguages.find((item) => item === locale) ?? "en";
    await waitForStorageMigration(language);
    const updating = await updater.beforeLaunch((state) =>
      setSplashStatus(
        state.phase === "checking"
          ? shellText(language, "updateChecking")
          : state.phase === "downloading"
            ? shellText(language, "updateDownloading", { version: state.version, percent: state.percent })
            : shellText(language, "updateInstalling", { version: state.version }),
      ),
    );
    if (updating) {
      app.exit(0);
      return;
    }
    setSplashStatus("");
    registerSceneProtocol(projectRoot());
    backendDataRoot = configuredStorageRoot();
    services.start(backendDataRoot);
    appLogs.start();
    socialSocket.start();
    streamBackendEvents(
      backendEndpoint,
      (event) => {
        mainWindow?.webContents.send(ipcChannels.backendEvent, event);
        taskbar.backendEvent(event);
      },
      backendEventsStop.signal,
    );
    desktopLaunch = startDesktopLaunch(shell, notify);
    discord = startDiscordPresence(shell, () => shell.status().discordPresence);
    const roomParticipant = await roomParticipantId();
    openMainWindow(roomParticipant);
    setTimeout(revealMainWindow, splashFallbackMilliseconds).unref();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) openMainWindow(roomParticipant);
    });
  })
  .catch((error: unknown) => {
    // Without this a failed start left an invisible process: no splash, no window, no message.
    showStartupError(error);
    closeSplash();
    app.quit();
  });

let servicesStopped = false;
let servicesStopping: Promise<void> | null = null;

const stopServicesOnce = (): void => {
  closeSplash();
  desktopLaunch?.stop();
  discord?.stop();
  radioNowPlaying.stop();
  updater.stop();
  trayRadio.destroy();
  void appLogs.stop();
  socialSocket.stop();
  backendEventsStop.abort();
  if (servicesStopped || !isPrimaryInstance) return;
  servicesStopped = true;
  services.stop();
};

app.on("before-quit", (event) => {
  quitting = true;
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
