import { afterEach, assert, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import type { ServiceObserver } from './ServiceProcess';

const mocks = vi.hoisted(() => ({
  services: [] as {
    command: string;
    env: NodeJS.ProcessEnv;
    observer: ServiceObserver;
  }[],
  packaged: false,
  consent: true,
  frontendEnv: '',
  files: new Map<string, string>(),
  setServerLogUploadsDisabled: vi.fn(),
  audioRequest: vi.fn(async () => ({
    status: 0,
    text: 'SessionState: Running\nPlaybackState: 3\n',
  })),
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mocks.packaged;
    },
    getPath: () => 'C:/Users/test/AppData/Roaming/AD Voice',
    getVersion: () => '1.1.38',
  },
}));
vi.mock('node:fs', () => ({
  existsSync: (file: string) => (mocks.packaged ? mocks.files.has(file) : true),
  readFileSync: (file: string) => {
    if (!mocks.packaged) return mocks.frontendEnv;
    const contents = mocks.files.get(file);
    if (contents !== undefined) return contents;
    throw Object.assign(new Error('File not found'), { code: 'ENOENT' });
  },
  mkdirSync: () => undefined,
  copyFileSync: (source: string, target: string) => {
    mocks.files.set(target, mocks.files.get(source) ?? '');
  },
  constants: { COPYFILE_EXCL: 1 },
}));
vi.mock('./RoomServerTransport', () => ({
  leaveRoomVoice: vi.fn(),
  setServerLogUploadsDisabled: mocks.setServerLogUploadsDisabled,
}));
vi.mock('./PrivacySettings', () => ({
  diagnosticsConsent: () => ({ enabled: mocks.consent, recordedAt: null }),
}));
vi.mock('./AudioServiceTransport', () => ({
  sendAudioRequest: mocks.audioRequest,
}));
vi.mock('./AppPaths', () => ({
  audioExecutable: () => 'D:/app/AudioService.exe',
  projectRoot: () => 'D:/app',
  pythonRoot: () => 'D:/app/python',
  pythonExecutable: () => 'D:/app/python/python.exe',
}));
vi.mock('./ServiceProcess', () => ({
  ServiceProcess: class {
    constructor(
      command: string,
      _args: string[],
      _cwd: string,
      env: NodeJS.ProcessEnv,
      observer: ServiceObserver,
    ) {
      mocks.services.push({ command, env, observer });
    }
    start() {}
    stop() {
      return Promise.resolve();
    }
  },
}));

afterEach(() => {
  mocks.packaged = false;
  mocks.consent = true;
  mocks.frontendEnv = '';
  mocks.services.length = 0;
  mocks.files.clear();
  mocks.setServerLogUploadsDisabled.mockReset();
  mocks.audioRequest.mockClear();
  vi.unstubAllEnvs();
  Reflect.deleteProperty(process, 'resourcesPath');
});

it("reads the packaged profile's frontend.env log opt-out and ignores commented examples", async () => {
  mocks.packaged = true;
  vi.stubEnv('AD_VOICE_DISABLE_SERVER_LOGS', undefined);
  const { serverLogUploadsDisabled } = await import('./ManagedServices');
  const frontendFile = join('D:/profile-a', 'environment', 'frontend.env');

  mocks.files.set(
    frontendFile,
    '# AD_VOICE_DISABLE_SERVER_LOGS=1\nAD_VOICE_ROOM_SERVER_HOST=rooms.example.com\n',
  );
  expect(serverLogUploadsDisabled('D:/profile-a')).toBe(false);

  mocks.files.set(
    frontendFile,
    `${mocks.files.get(frontendFile)}AD_VOICE_DISABLE_SERVER_LOGS=0\n`,
  );
  expect(serverLogUploadsDisabled('D:/profile-a')).toBe(true);
});

it('treats a present process environment key as an opt-out even when empty', async () => {
  vi.stubEnv('AD_VOICE_DISABLE_SERVER_LOGS', '');
  const { serverLogUploadsDisabled } = await import('./ManagedServices');
  expect(serverLogUploadsDisabled('D:/profile-a')).toBe(true);
});

it('applies a bundled log opt-out on the first packaged launch after seeding frontend.env', async () => {
  mocks.packaged = true;
  vi.stubEnv('AD_VOICE_DISABLE_SERVER_LOGS', undefined);
  vi.stubEnv('AD_VOICE_FRONTEND_ENV_FILE', undefined);
  const resourceRoot = 'D:/app/resources';
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: resourceRoot,
  });
  const bundledFile = join(resourceRoot, 'frontend', '.env.local');
  const profileFile = join('D:/profile-a', 'environment', 'frontend.env');
  mocks.files.set(bundledFile, 'AD_VOICE_DISABLE_SERVER_LOGS=1\n');
  mocks.files.set('D:/app/AudioService.exe', '');
  const { ManagedServices } = await import('./ManagedServices');

  new ManagedServices({
    started: vi.fn(),
    stopped: vi.fn(),
    stdout: vi.fn(),
  } as never).start('D:/profile-a');

  expect(mocks.files.get(profileFile)).toBe('AD_VOICE_DISABLE_SERVER_LOGS=1\n');
  expect(mocks.setServerLogUploadsDisabled).toHaveBeenCalledWith(true);
});

it('sends service output and automatic audio diagnostics without losing backend readiness', async () => {
  const { ManagedServices } = await import('./ManagedServices');
  const endpoint = { started: vi.fn(), stopped: vi.fn(), stdout: vi.fn() };
  const log = vi.fn();
  const diagnostics = vi.fn();
  const services = new ManagedServices(endpoint as never, log, diagnostics);
  services.start('D:/data');
  const python = mocks.services.find(
    (service) => service.command !== 'D:/app/AudioService.exe',
  );
  const audio = mocks.services.find(
    (service) => service.command === 'D:/app/AudioService.exe',
  );
  const ready = Buffer.from('AD_VOICE_BACKEND_READY:12345\n');
  const failed = Buffer.from('WASAPI: Start failed\n');
  python?.observer.stdout?.(ready);
  audio?.observer.stderr?.(failed);
  expect(endpoint.stdout).toHaveBeenCalledWith(ready);
  expect(log.mock.calls).toEqual([
    ['python', 'info', ready],
    ['audio-service', 'error', failed],
  ]);
  expect(python?.env.PYTHONIOENCODING).toBe('utf-8');
  await services.captureAudioDiagnostics('command-failed:Play');
  expect(mocks.audioRequest).toHaveBeenCalledWith(
    { command: 'GetDiagnostics' },
    1000,
  );
  expect(diagnostics).toHaveBeenCalledOnce();
  const report = diagnostics.mock.calls[0];
  assert(report);
  expect(JSON.parse(report[0])).toMatchObject({
    reason: 'stderr',
    status: 0,
    diagnostics: 'SessionState: Running\nPlaybackState: 3\n',
  });
  services.stop();
});

it('starts with no diagnostic upload or automatic snapshot before consent', async () => {
  mocks.consent = false;
  const { ManagedServices } = await import('./ManagedServices');
  const diagnostics = vi.fn();
  const services = new ManagedServices(
    { started: vi.fn(), stopped: vi.fn(), stdout: vi.fn() } as never,
    vi.fn(),
    diagnostics,
  );
  services.start('D:/data');
  await services.captureAudioDiagnostics('failure');
  expect(mocks.setServerLogUploadsDisabled).toHaveBeenCalledWith(true);
  expect(diagnostics).not.toHaveBeenCalled();
  services.stop();
});
