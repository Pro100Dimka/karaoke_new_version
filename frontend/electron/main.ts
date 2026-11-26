import { app, BrowserWindow, dialog, Menu } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnvFile } from 'node:process';
import { configuredStorageRoot, projectRoot, themeIconPath } from './AppPaths';
import { AppLogUploader, sendAppLogs } from './AppLogUploader';
import { requireObject, requireString } from './RequestValidation';
import { BackendEndpoint } from './BackendEndpoint';
import { streamBackendEvents } from './BackendEvents';
import { registerDesktopIpc } from './DesktopIpc';
import { ipcChannels } from './ipcChannels';
import { createKeyboardLightingProvider } from './KeyboardLighting';
import { createMainWindow } from './MainWindow';
import { flushWindowState } from './WindowState';
import { ManagedServices } from './ManagedServices';
import { registerProjectFileHandlers } from './ProjectFiles';
import { roomParticipantId } from './RoomIdentity';
import { registerRoomProjectTransferHandlers } from './RoomProjectTransfer';
import {
  roomServerApiBase,
  roomServerRequest,
  serverLogUploadsDisabled,
  leaveRoomVoice,
} from './RoomServerTransport';
import {
  diagnosticsConsent,
  saveDiagnosticsConsent,
  saveTransferConsent,
  transferConsents,
  transferPurposes,
} from './PrivacySettings';
import {
  onlineAccountEnabled,
  accountIdentityEnabled,
  recordTransferConsent,
  setOnlineAccountEnabled,
  withDevice,
} from './SocialIdentity';
import { configureRuntimeIdentity } from './RuntimeIdentity';
import { registerSceneProtocol } from './SceneProtocol';
import { registerServiceIpc } from './ServiceIpc';
import { registerSocialChannel } from './SocialChannel';
import {
  closeSplash,
  openSplash,
  readSavedTheme,
  setSplashStatus,
  waitForStorageMigration,
  hasPendingStorageMigration,
} from './Splash';
import { shellLanguages, shellText } from './ShellText';
import { createTrustedIpc } from './TrustedIpc';
import { applyGpuSwitches } from './GpuSwitches';
import { startAutoUpdate } from './AutoUpdate';
import { startRadioNowPlaying } from './RadioNowPlaying';
import { startDesktopLaunch } from './DesktopLaunch';
import {
  commandsFromArguments,
  DesktopShell,
  resolveLaunchArguments,
} from './DesktopShell';
import { startDiscordPresence } from './DiscordPresence';
import { createShellNotifier, registerShellIpc } from './ShellIpc';
import { createTaskbarIntegration } from './TaskbarIntegration';
import { createTrayRadio } from './TrayRadio';
import { configureNotificationIdentity } from './NotificationIdentity';
import { takeLegalStartupWindow, registerLegalViewer } from './LegalDocuments';

const startupFailed: Readonly<Record<string, string>> = {
  ru: 'Не удалось запустить приложение.',
  uk: 'Не вдалося запустити застосунок.',
};

const showStartupError = (error: unknown): void => {
  console.error('Application startup failed', error);
  const locale = app.isReady() ? app.getLocale().slice(0, 2) : 'en';
  const headline = startupFailed[locale] ?? 'The application could not start.';
  const detail = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox('A&D Voice', `${headline}\n\n${detail}`);
};

if (!app.isPackaged) {
  try {
    loadEnvFile(path.join(app.getAppPath(), '.env.local'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
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
  process.env.VITE_DEV_SERVER_URL ??
  pathToFileURL(path.join(__dirname, '../dist/index.html')).href;

let mainWindow: BrowserWindow | null = null;
let mainRevealed = false;
let closeConfirmed = false;
let backendDataRoot = '';
/** Set when the app starts to quit: closing the window then really closes it (no hiding to the tray). */
let quitting = false;
let relaunchRequested = false;
let relaunchScheduled = false;
let updateQuitRequested = false;

const resetQuitRequest = (): void => {
  quitting = false;
  relaunchRequested = false;
  updateQuitRequested = false;
};

/** Electron starts the replacement only after this process exits; schedule it once. */
const scheduleRelaunch = (args?: string[]): void => {
  if (relaunchScheduled) return;
  app.relaunch(args ? { args } : undefined);
  relaunchScheduled = true;
};

const trustedIpc = createTrustedIpc(() => mainWindow, rendererUrl);
const backendEndpoint = new BackendEndpoint();
const backendEventsStop = new AbortController();
const appLogs = new AppLogUploader(
  sendAppLogs,
  path.join(app.getPath('userData'), 'pending-app-logs.json'),
);
appLogs.captureConsole(console);
trustedIpc.handle(ipcChannels.sendErrorReport, (_event, text: unknown) =>
  appLogs.sendReport(requireString(text, 'report')),
);
const services = new ManagedServices(
  backendEndpoint,
  (source, level, data) => appLogs.write(source, level, data),
  (text) => appLogs.addSnapshot('audio-diagnostics', text),
);
const storageRoot = () => backendDataRoot || configuredStorageRoot();

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
trustedIpc.handle(
  ipcChannels.privacySettings,
  async (_event, action: unknown, input: unknown) => {
    if (action === 'transfer') {
      const value = requireObject(input, 'transfer consent');
      const purpose = transferPurposes.find(
        (purpose) => purpose === value.purpose,
      );
      if (!purpose || typeof value.enabled !== 'boolean')
        throw new TypeError('Invalid transfer choice');
      if (value.enabled) {
        if (purpose !== 'online' && !(await onlineAccountEnabled()))
          throw new Error('Enable online transfers first');
        if (Object.values(transferConsents()).some((choice) => choice.pending))
          throw new Error('Synchronize the pending withdrawal first');
        await recordTransferConsent(purpose, true);
        saveTransferConsent(purpose, true);
        if (purpose === 'online') {
          await onlineAccountEnabled();
          socialSocket.stop();
          socialSocket.start();
        }
      } else {
        const stopping: Promise<unknown>[] = [];
        saveTransferConsent(purpose, false, true);
        if (['online', 'processing'].includes(purpose))
          stopping.push(
            backendEndpoint
              .request('/settings/transfers/withdraw', { method: 'POST' })
              .catch(() => undefined),
          );
        if (purpose === 'online') {
          for (const dependent of ['processing', 'diagnostics'] as const)
            saveTransferConsent(dependent, false);
          socialSocket.stop();
          stopping.push(leaveRoomVoice().catch(() => undefined));
          mainWindow?.webContents.send(ipcChannels.socialInbox, {
            type: 'offline',
          });
        }
        if (['online', 'diagnostics'].includes(purpose)) {
          saveDiagnosticsConsent(false);
          services.setDiagnosticUploads(false);
          stopping.push(appLogs.discard());
        }
        await Promise.all([recordTransferConsent(purpose, false), ...stopping]);
        saveTransferConsent(purpose, false);
      }
      if (purpose === 'diagnostics') {
        saveDiagnosticsConsent(value.enabled);
        services.setDiagnosticUploads(value.enabled);
      }
    } else if (action === 'diagnostics') {
      if (typeof input !== 'boolean')
        throw new TypeError('Diagnostic consent must be a boolean');
      if (input && !transferConsents().diagnostics.enabled)
        throw new Error('Confirm the diagnostic transfer notice first');
      saveDiagnosticsConsent(input);
      if (!services.setDiagnosticUploads(input)) await appLogs.discard();
      if (!input) {
        saveTransferConsent('diagnostics', false, true);
        await recordTransferConsent('diagnostics', false);
        saveTransferConsent('diagnostics', false);
      }
    } else if (action === 'delete-account') {
      const request = await withDevice({
        method: 'DELETE',
        path: '/social/me',
        body: {
          accountId: requireString(input, 'accountId'),
        },
      });
      socialSocket.stop();
      let response = await roomServerRequest(request);
      const deadline = Date.now() + 120_000;
      while (
        !response.ok &&
        response.body &&
        typeof response.body === 'object' &&
        'code' in response.body &&
        response.body.code === 'ProcessingErasurePending' &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        response = await roomServerRequest(request);
      }
      if (!response.ok) {
        socialSocket.start();
        throw new Error(
          `Account deletion failed (${response.status}). Retry when uploads have finished and the server is available.`,
        );
      }
      saveDiagnosticsConsent(false);
      for (const purpose of transferPurposes)
        saveTransferConsent(purpose, false);
      services.setDiagnosticUploads(false);
      await appLogs.discard();
      shell.report({ ...shell.status(), discordPresence: false });
      discord?.refresh?.();
      await setOnlineAccountEnabled(false);
      mainWindow?.webContents.send(ipcChannels.socialInbox, {
        type: 'offline',
      });
      return;
    } else if (action === 'create-account') {
      await setOnlineAccountEnabled(true);
      for (const purpose of transferPurposes)
        if (transferConsents()[purpose].enabled)
          await recordTransferConsent(purpose, true);
      return;
    } else if (action !== 'read') {
      throw new TypeError('Unknown privacy action');
    }
    return {
      transfers: transferConsents(),
      diagnosticsEnabled: !serverLogUploadsDisabled(),
      diagnosticsRecordedAt: diagnosticsConsent().recordedAt,
      accountEnabled: await accountIdentityEnabled(),
    };
  },
);

const retryWithdrawals = setInterval(() => {
  void (async () => {
    for (const purpose of transferPurposes) {
      const choice = transferConsents()[purpose];
      if (choice.pending && !choice.enabled) {
        await recordTransferConsent(purpose, false);
        saveTransferConsent(purpose, false);
      }
    }
  })().catch(() => undefined);
}, 30_000);
retryWithdrawals.unref();

// The desktop shell: taskbar, tray, jump list, invitation links, mute hotkey, Discord and updates.
const shell = new DesktopShell();
trustedIpc.handle(ipcChannels.showLegalDocuments, () => {
  mainWindow?.webContents.send(ipcChannels.showLegalDocuments);
  return true;
});
const notify = createShellNotifier(
  () => mainWindow,
  themeIconPath(readSavedTheme()) ?? undefined,
);
registerShellIpc(trustedIpc, shell, () => mainWindow, notify);
const taskbar = createTaskbarIntegration({
  window: () => mainWindow,
  shell,
  notify,
});
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
const updateSettingsFile = () =>
  path.join(app.getPath('userData'), 'update-settings.json');
const readAutoUpdate = (): boolean => {
  try {
    return (
      (
        JSON.parse(fs.readFileSync(updateSettingsFile(), 'utf8')) as {
          automatic?: unknown;
        }
      ).automatic !== false
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('Cannot read update settings', error);
      shell.send({
        type: 'operationFailure',
        operation: 'errors.updateSettingsRead',
        failed: true,
      });
    }
    return true;
  }
};
let savedAutoUpdate: boolean | undefined;
shell.onStatus((next) => {
  savedAutoUpdate ??= readAutoUpdate();
  if (next.autoUpdate === savedAutoUpdate) return;
  try {
    fs.writeFileSync(
      updateSettingsFile(),
      JSON.stringify({ automatic: next.autoUpdate }),
    );
    savedAutoUpdate = next.autoUpdate;
    shell.send({
      type: 'operationFailure',
      operation: 'errors.updateSettingsSave',
      failed: false,
    });
  } catch (error) {
    console.error('Cannot save update settings', error);
    shell.send({
      type: 'operationFailure',
      operation: 'errors.updateSettingsSave',
      failed: true,
    });
  }
});
const pendingLaunches: (readonly string[])[] = [];
const hasLaunchIntent = (argv: readonly string[]): boolean =>
  commandsFromArguments(argv.slice(1), () => true).length > 0;
const updater = startAutoUpdate({
  ready: (version) => shell.send({ type: 'updateReady', version }),
  automatic: readAutoUpdate,
  canInstallBeforeLaunch: () =>
    !hasLaunchIntent(process.argv) && !pendingLaunches.some(hasLaunchIntent),
  available: (version) => shell.send({ type: 'updateAvailable', version }),
  progress: (percent) => shell.send({ type: 'updateProgress', percent }),
  installFailed: () => shell.send({ type: 'updateFailed' }),
  log: (level, message) => appLogs.add('updater', level, message),
  quit: () => {
    relaunchRequested = false;
    updateQuitRequested = true;
    app.quit();
  },
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
  mainRevealed = false;
  closeConfirmed = false;
  const window = createMainWindow({
    existingWindow: takeLegalStartupWindow(),
    rendererUrl,
    trustedIpc,
    roomParticipant,
    log: (source, level, message) => {
      appLogs.add(source, level, message);
      if (['error', 'critical'].includes(level.toLowerCase()))
        void services.captureAudioDiagnostics(`${source}-error`);
    },
    closeConfirmed: () => closeConfirmed,
    closeToTray: () => trayRadio.closeToTray(),
    reveal: revealMainWindow,
  });
  mainWindow = window;
  registerLegalViewer(window, rendererUrl);
  // Windows takes thumbnail buttons only from a visible window.
  window.on('show', () => {
    trayRadio.windowShown();
    taskbar.refresh();
  });
  window.on('closed', () => {
    mainWindow = null;
  });
};

registerDesktopIpc({
  trustedIpc,
  window: () => mainWindow,
  storageRoot,
  reveal: revealMainWindow,
  requestRelaunch: () => {
    updater.cancelInstall();
    updateQuitRequested = false;
    relaunchRequested = true;
    app.quit();
  },
  confirmClose: async (allowed) => {
    if (!allowed) {
      resetQuitRequest();
      updater.cancelInstall();
      return;
    }
    try {
      if (!(await updater.prepareQuit())) {
        resetQuitRequest();
        return;
      }
    } catch (error) {
      resetQuitRequest();
      throw error;
    }
    if (relaunchRequested) {
      relaunchRequested = false;
      scheduleRelaunch();
    }
    closeConfirmed = true;
    mainWindow?.close();
  },
});
registerServiceIpc(
  trustedIpc,
  backendEndpoint,
  createKeyboardLightingProvider(),
  (reason) => void services.captureAudioDiagnostics(reason),
);

// One instance owns the services and the audio pipe; a second launch must not kill them, it only focuses the window.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();
const startManagedServices = (): void => {
  if (backendDataRoot) return;
  backendDataRoot = configuredStorageRoot();
  services.start(backendDataRoot);
};
// Services can prepare alongside Electron unless an update or migration owns the files.
let earlyStartupError: unknown;
try {
  if (
    isPrimaryInstance &&
    !hasPendingStorageMigration() &&
    !updater.requiresLaunchCheck()
  )
    startManagedServices();
} catch (error) {
  earlyStartupError = error;
}
app.on('second-instance', (_event, argv, workingDirectory) => {
  const launchArguments = workingDirectory
    ? resolveLaunchArguments(argv, workingDirectory)
    : argv;
  // The last window can be gone while its services are still stopping and the instance lock is held.
  // Preserve this launch without starting another owner of those services before shutdown finishes.
  if (quitting && (!mainWindow || mainWindow.isDestroyed())) {
    if (!updateQuitRequested) scheduleRelaunch(launchArguments.slice(1));
    return;
  }
  // A second launch hands over what it was started for: an invitation link, a task, opened files.
  if (desktopLaunch) desktopLaunch.secondLaunch(launchArguments);
  else pendingLaunches.push([...launchArguments]);
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  // The window may be hidden in the tray while the radio plays.
  mainWindow.show();
  mainWindow.focus();
});

app
  .whenReady()
  .then(async () => {
    if (earlyStartupError !== undefined) throw earlyStartupError;
    // The windows are frameless and draw their own controls; a released app also drops the default
    // menu's hidden shortcuts (developer tools, reload) that would otherwise still respond to keys.
    if (app.isPackaged) Menu.setApplicationMenu(null);
    if (!isPrimaryInstance) return;
    openSplash(
      themeIconPath(readSavedTheme()),
      path.join(__dirname, '..', 'electron', 'splash.html'),
    );
    // As in Discord: a newer version is installed before the app opens; offline it simply opens.
    const locale = app.getLocale().slice(0, 2);
    const language = shellLanguages.find((item) => item === locale) ?? 'en';
    await waitForStorageMigration(language);
    const updating = await updater.beforeLaunch((state) =>
      setSplashStatus(
        state.phase === 'checking'
          ? shellText(language, 'updateChecking')
          : state.phase === 'downloading'
            ? shellText(language, 'updateDownloading', {
                version: state.version,
                percent: state.percent,
              })
            : shellText(language, 'updateInstalling', {
                version: state.version,
              }),
      ),
    );
    if (updating) {
      app.exit(0);
      return;
    }
    setSplashStatus('');
    registerSceneProtocol(projectRoot());
    startManagedServices();
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
    for (const argv of pendingLaunches.splice(0))
      desktopLaunch.secondLaunch(argv);
    discord = startDiscordPresence(shell, () => shell.status().discordPresence);
    const roomParticipant = await roomParticipantId();
    openMainWindow(roomParticipant);
    setTimeout(revealMainWindow, splashFallbackMilliseconds).unref();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0)
        openMainWindow(roomParticipant);
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

app.on('before-quit', (event) => {
  quitting = true;
  if (servicesStopped || !isPrimaryInstance) return;
  event.preventDefault();
  if (mainWindow && !mainWindow.isDestroyed() && !closeConfirmed) {
    mainWindow.close();
    return;
  }
  closeSplash();
  servicesStopping ??= services.stopGracefully().finally(async () => {
    // The uploader bounds its network drain; accepted asynchronous queue writes
    // must finish before Electron exits and abandons their rename.
    await appLogs.stop();
    await flushWindowState();
    servicesStopped = true;
    app.quit();
  });
});
app.on('will-quit', stopServicesOnce);
process.on('exit', stopServicesOnce);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
