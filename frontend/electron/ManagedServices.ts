import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  audioExecutable,
  projectRoot,
  pythonRoot,
  pythonExecutable,
} from './AppPaths';
import { sendAudioRequest } from './AudioServiceTransport';
import type { BackendEndpoint } from './BackendEndpoint';
import {
  leaveRoomVoice,
  setServerLogUploadsDisabled,
} from './RoomServerTransport';
import { ServiceProcess } from './ServiceProcess';
import { gpuRuntimeDir } from './GpuRuntime';
import { diagnosticsConsent } from './PrivacySettings';

interface EnvironmentFiles {
  project: string | undefined;
  python: string | undefined;
  frontend: string | undefined;
}

/** Each service's .env file: as configured, else (in a release) inside the data folder. */
const environmentFiles = (dataRoot: string): EnvironmentFiles => {
  const inData = (name: string) =>
    app.isPackaged ? path.join(dataRoot, 'environment', name) : undefined;
  return {
    project: inData('project.env') ?? process.env.AD_VOICE_PROJECT_ENV_FILE,
    python: inData('python.env') ?? process.env.AD_VOICE_ENV_FILE,
    frontend: inData('frontend.env') ?? process.env.AD_VOICE_FRONTEND_ENV_FILE,
  };
};

/** A present key disables this profile's client log uploads, regardless of its value. */
export const serverLogUploadsDisabled = (dataRoot: string): boolean => {
  if (process.env.AD_VOICE_DISABLE_SERVER_LOGS !== undefined) return true;
  const frontendFile =
    environmentFiles(dataRoot).frontend ??
    path.join(dataRoot, 'environment', 'frontend.env');
  try {
    return /^[ \t]*(?:export[ \t]+)?AD_VOICE_DISABLE_SERVER_LOGS[ \t]*=/m.test(
      fs.readFileSync(frontendFile, 'utf8'),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    console.warn(
      `Cannot read frontend environment file: ${frontendFile}`,
      error,
    );
    return true;
  }
};

/** A release ships default .env files; the first start copies them where the user can edit them. */
const seedEnvironmentFiles = (files: EnvironmentFiles): void => {
  if (!app.isPackaged) return;
  const seeds = [
    [
      path.join(process.resourcesPath, 'local-secrets', 'env', 'project.env'),
      files.project,
    ],
    [path.join(pythonRoot(), '.env'), files.python],
    [
      path.join(process.resourcesPath, 'frontend', '.env.local'),
      files.frontend,
    ],
  ] as const;
  for (const [source, target] of seeds) {
    if (!target || fs.existsSync(target) || !fs.existsSync(source)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  }
};

/** The Python backend and AudioService this app starts, restarts and stops. */
export class ManagedServices {
  private python: ServiceProcess | null = null;
  private audio: ServiceProcess | null = null;
  private diagnosticsEnabled = false;
  private capturingDiagnostics = false;
  private dataRoot = '';

  setDiagnosticUploads(enabled: boolean): boolean {
    const disabled = !enabled || serverLogUploadsDisabled(this.dataRoot);
    setServerLogUploadsDisabled(disabled);
    this.diagnosticsEnabled = !disabled && this.diagnostics !== undefined;
    return !disabled;
  }

  constructor(
    private readonly backendEndpoint: BackendEndpoint,
    private readonly log: (
      source: string,
      level: string,
      data: Buffer,
    ) => void = () => undefined,
    private readonly diagnostics?: (text: string) => void,
  ) {}

  async captureAudioDiagnostics(reason: string): Promise<void> {
    if (!this.diagnosticsEnabled || !this.audio || this.capturingDiagnostics)
      return;
    this.capturingDiagnostics = true;
    try {
      const response = await sendAudioRequest(
        { command: 'GetDiagnostics' },
        1000,
      );
      if (this.diagnosticsEnabled)
        this.diagnostics?.(
          JSON.stringify({
            version: app.getVersion(),
            reason,
            status: response.status,
            diagnostics: response.text,
          }),
        );
    } catch (error) {
      if (this.diagnosticsEnabled)
        this.log(
          'audio-service',
          'error',
          Buffer.from(
            `Audio diagnostics unavailable (${reason}): ${String(error)}\n`,
          ),
        );
    } finally {
      this.capturingDiagnostics = false;
    }
  }

  start(dataRoot: string): void {
    const files = environmentFiles(dataRoot);
    seedEnvironmentFiles(files);
    this.dataRoot = dataRoot;
    this.setDiagnosticUploads(diagnosticsConsent().enabled);
    const tools = app.isPackaged
      ? path.join(process.resourcesPath, 'tools')
      : path.join(projectRoot(), 'vendor', 'ffmpeg', 'bin');
    const executablePath = `${tools}${path.delimiter}${process.env.PATH ?? ''}`;
    this.python = new ServiceProcess(
      pythonExecutable(),
      ['-m', 'backend.main'],
      pythonRoot(),
      {
        ...process.env,
        AD_VOICE_DATA: dataRoot,
        AD_VOICE_PORT: process.env.AD_VOICE_PORT ?? '0',
        AD_VOICE_MANAGED: '1',
        AD_VOICE_LOCAL_API_TOKEN: this.backendEndpoint.accessToken,
        PYTHONIOENCODING: 'utf-8',
        AD_VOICE_PROJECT_ENV_FILE: files.project,
        AD_VOICE_ENV_FILE: files.python,
        AD_VOICE_FRONTEND_ENV_FILE: files.frontend,
        AD_VOICE_KAGGLE_ASSETS: path.join(projectRoot(), 'kaggle'),
        PYTHONPATH: app.isPackaged ? pythonRoot() : process.env.PYTHONPATH,
        // A released app carries PyTorch's CPU build; on an NVIDIA computer the backend fetches the
        // CUDA build here once and uses it from the next job on (GpuRuntime.ts).
        ...(app.isPackaged
          ? { AD_VOICE_GPU_RUNTIME_DIR: gpuRuntimeDir(app.getPath('userData')) }
          : {}),
        PATH: executablePath,
      },
      {
        started: () => this.backendEndpoint.started(),
        stopped: () => this.backendEndpoint.stopped(),
        stdout: (data) => {
          this.backendEndpoint.stdout(data);
          this.log('python', 'info', data);
        },
        stderr: (data) => this.log('python', 'error', data),
      },
    );
    this.python.start();

    const executable = audioExecutable();
    if (!fs.existsSync(executable)) {
      console.warn(`AudioService executable not found: ${executable}`);
      return;
    }
    this.audio = new ServiceProcess(
      executable,
      [],
      path.dirname(executable),
      process.env,
      {
        exited: (code, signal) => {
          this.log(
            'audio-service',
            'error',
            Buffer.from(
              `AudioService exited unexpectedly: code=${code}, signal=${signal}; automatic restart scheduled\n`,
            ),
          );
          void this.captureAudioDiagnostics('process-exited');
        },
        stdout: (data) => this.log('audio-service', 'info', data),
        stderr: (data) => {
          this.log('audio-service', 'error', data);
          void this.captureAudioDiagnostics('stderr');
        },
      },
    );
    this.audio.start();
  }

  /** Ends both at once, for a process that is exiting anyway. */
  stop(): void {
    this.diagnosticsEnabled = false;
    const services = [this.audio, this.python];
    this.audio = null;
    this.python = null;
    for (const service of services) void service?.stop();
  }

  /** Asks each to shut down cleanly (AudioService leaves the room voice first), then ends them. */
  async stopGracefully(): Promise<void> {
    this.diagnosticsEnabled = false;
    const { audio, python } = this;
    await Promise.allSettled([
      audio?.stop(() => sendAudioRequest({ command: 'ShutdownService' })),
      python?.stop(async () => {
        python.endInput();
      }),
      audio ? leaveRoomVoice() : Promise.resolve(),
    ]);
    if (this.audio === audio) this.audio = null;
    if (this.python === python) this.python = null;
  }
}
