import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';

const mocks = vi.hoisted(() => ({
  profileRoot: '',
  handlers: new Map<
    string,
    (event: IpcMainInvokeEvent, raw?: unknown) => unknown
  >(),
  ready: { run: (): unknown => undefined },
  sendAudioRequest: vi.fn().mockResolvedValue({ status: 0, text: 'Running' }),
  appEvents: new Map<
    string,
    (
      event: { preventDefault(): void },
      argv?: string[],
      workingDirectory?: string,
    ) => void
  >(),
  stopService: vi.fn(),
  quit: vi.fn(),
  relaunch: vi.fn(),
  gpuSwitch: vi.fn(),
  beforeLaunch: vi.fn(async () => false),
  prepareUpdateQuit: vi.fn(async () => true),
  updateQuit: { run: () => undefined as void },
  scene: vi.fn<(request: Request) => Response | Promise<Response>>(),
  pythonObserver: {} as {
    started?(): void;
    stdout?(data: Buffer): void;
    stopped?(): void;
  },
}));

export const contents = Object.assign(new EventEmitter(), {
  mainFrame: { url: '' },
  send: vi.fn(),
  isDestroyed: () => false,
  setWindowOpenHandler: vi.fn(),
});
export const window = Object.assign(new EventEmitter(), {
  webContents: contents,
  isDestroyed: () => false,
  isVisible: () => true,
  isFocused: () => true,
  isMinimized: () => false,
  show: vi.fn(),
  focus: vi.fn(),
  restore: vi.fn(),
  close: vi.fn(),
  loadURL: vi.fn(async (url: string) => {
    contents.mainFrame.url = url;
  }),
  loadFile: vi.fn(async () => {
    contents.mainFrame.url =
      'file:///D:/Git/karaoke_new_version/frontend/dist/index.html';
  }),
});
let trustedRendererUrl = '';

vi.mock('../electron/AppLogUploader', () => ({
  AppLogUploader: class {
    captureConsole = vi.fn();
    start = vi.fn();
    stop = vi.fn().mockResolvedValue(undefined);
    write = vi.fn();
    add = vi.fn();
    sendReport = vi.fn().mockResolvedValue(undefined);
  },
  sendAppLogs: vi.fn().mockResolvedValue(undefined),
}));

// The desktop shell (taskbar, tray, jump list, links, Discord, updates) has its own tests; here it stays out of the way.
vi.mock('../electron/DesktopLaunch', () => ({
  startDesktopLaunch: () => ({ secondLaunch: vi.fn(), stop: vi.fn() }),
}));
vi.mock('../electron/TrayRadio', () => ({
  createTrayRadio: () => ({ closeToTray: () => false, destroy: vi.fn() }),
}));
vi.mock('../electron/TaskbarIntegration', () => ({
  createTaskbarIntegration: () => ({ backendEvent: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../electron/DiscordPresence', () => ({
  startDiscordPresence: () => ({ stop: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../electron/AutoUpdate', () => ({
  startAutoUpdate: ({ quit }: { quit(): void }) => {
    mocks.updateQuit.run = quit;
    return {
      requiresLaunchCheck: () => false,
      beforeLaunch: mocks.beforeLaunch,
      install: () => false,
      prepareQuit: mocks.prepareUpdateQuit,
      cancelInstall: vi.fn(),
      stop: vi.fn(),
    };
  },
}));
vi.mock('../electron/ShellIpc', () => ({
  createShellNotifier: () => vi.fn(),
  registerShellIpc: vi.fn(),
}));
vi.mock('../electron/NotificationIdentity', () => ({
  configureNotificationIdentity: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => mocks.profileRoot,
    getLocale: () => 'ru-RU',
    exit: vi.fn(),
    requestSingleInstanceLock: () => true,
    commandLine: { appendSwitch: mocks.gpuSwitch },
    quit: mocks.quit,
    relaunch: mocks.relaunch,
    setUserTasks: vi.fn(),
    on: (
      name: string,
      callback: (
        event: { preventDefault(): void },
        argv?: string[],
        workingDirectory?: string,
      ) => void,
    ) => mocks.appEvents.set(name, callback),
    whenReady: () => ({
      then: (callback: () => unknown) => {
        mocks.ready.run = callback;
        return { catch: () => undefined };
      },
    }),
  },
  BrowserWindow: Object.assign(
    vi.fn(function () {
      return window;
    }),
    { getAllWindows: () => [] },
  ),
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: IpcMainInvokeEvent, raw?: unknown) => unknown,
    ) => mocks.handlers.set(channel, handler),
  },
  clipboard: {},
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: (_scheme: string, handler: (request: Request) => Response) =>
      mocks.scene.mockImplementation(handler),
  },
  dialog: {},
  shell: {},
  globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
  screen: { getAllDisplays: () => [{}], on: vi.fn() },
  powerMonitor: { isOnBatteryPower: () => false, on: vi.fn() },
}));
// Main-process tests keep network subscriptions at their service boundaries.
vi.mock('../electron/SocialSocket', () => ({
  createSocialSocket: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    setPresence: vi.fn(async () => undefined),
  }),
}));
vi.mock('../electron/BackendEvents', () => ({ streamBackendEvents: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    existsSync: () => false,
    default: { ...fs, existsSync: () => false },
  };
});
vi.mock('../electron/RuntimeIdentity', () => ({
  configureRuntimeIdentity: vi.fn(),
}));
vi.mock('../electron/ServiceProcess', () => ({
  ServiceProcess: class {
    constructor(
      _command: string,
      _args: string[],
      _cwd: string,
      _env: unknown,
      observer?: typeof mocks.pythonObserver,
    ) {
      mocks.pythonObserver = observer ?? {};
    }
    start() {
      mocks.pythonObserver.started?.();
    }
    endInput() {}
    stop(shutdown?: () => Promise<unknown>) {
      return mocks.stopService(shutdown);
    }
  },
}));
vi.mock('../electron/KeyboardLighting', () => ({
  createKeyboardLightingProvider: () => null,
}));
vi.mock('../electron/Splash', () => ({
  closeSplash: vi.fn(),
  openSplash: vi.fn(),
  setSplashStatus: vi.fn(),
  waitForStorageMigration: vi.fn(async () => undefined),
  hasPendingStorageMigration: () => false,
  readSavedTheme: () => 'dark',
  isThemeName: () => false,
}));
vi.mock('../electron/SceneProtocol', () => ({
  registerSceneProtocol: vi.fn(),
}));
vi.mock('../electron/WindowState', () => ({
  loadWindowState: () => ({ width: 1280, height: 720 }),
  saveWindowState: vi.fn(),
}));
vi.mock('../electron/AudioServiceTransport', () => ({
  sendAudioRequest: mocks.sendAudioRequest,
}));
vi.mock('../electron/RoomIdentity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../electron/RoomIdentity')>()),
  roomParticipantId: async () => 'participant',
  withRoomKey: async (headers: object) => headers,
}));

beforeAll(async () => {
  mocks.profileRoot = await mkdtemp(join(tmpdir(), 'ad-voice-main-security-'));
  vi.stubEnv('AD_VOICE_DATA', join(mocks.profileRoot, 'backend-data'));
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: 'D:/app/resources',
  });
  vi.stubEnv('AD_VOICE_AUDIO_SERVICE', 'unused.exe');
  await import('../electron/main');
  await mocks.ready.run();
  trustedRendererUrl = contents.mainFrame.url;
});
afterAll(async () => {
  Reflect.deleteProperty(process, 'resourcesPath');
  vi.unstubAllEnvs();
  if (mocks.profileRoot)
    await rm(mocks.profileRoot, { recursive: true, force: true });
});
beforeEach(() => {
  contents.mainFrame.url = trustedRendererUrl;
  mocks.sendAudioRequest.mockClear();
});

export { mocks };
