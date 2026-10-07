import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { audioExecutable, projectRoot, pythonRoot } from "./AppPaths";
import { sendAudioRequest } from "./AudioServiceTransport";
import type { BackendEndpoint } from "./BackendEndpoint";
import { leaveRoomVoice } from "./RoomServerTransport";
import { ServiceProcess } from "./ServiceProcess";

interface EnvironmentFiles {
  project: string | undefined;
  python: string | undefined;
  frontend: string | undefined;
}

/** Each service's .env file: as configured, else (in a release) inside the data folder. */
const environmentFiles = (dataRoot: string): EnvironmentFiles => {
  const inData = (name: string) =>
    app.isPackaged ? path.join(dataRoot, "environment", name) : undefined;
  return {
    project: process.env.AD_VOICE_PROJECT_ENV_FILE ?? inData("project.env"),
    python: process.env.AD_VOICE_ENV_FILE ?? inData("python.env"),
    frontend: process.env.AD_VOICE_FRONTEND_ENV_FILE ?? inData("frontend.env"),
  };
};

/** A release ships default .env files; the first start copies them where the user can edit them. */
const seedEnvironmentFiles = (files: EnvironmentFiles): void => {
  if (!app.isPackaged) return;
  const seeds = [
    [path.join(process.resourcesPath, "local-secrets", "env", "project.env"), files.project],
    [path.join(pythonRoot(), ".env"), files.python],
    [path.join(process.resourcesPath, "frontend", ".env.local"), files.frontend],
  ] as const;
  for (const [source, target] of seeds) {
    if (!target || fs.existsSync(target) || !fs.existsSync(source)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  }
};

const pythonExecutable = (): string => {
  const configured = process.env.AD_VOICE_PYTHON;
  if (configured !== undefined) return configured;
  if (app.isPackaged) return path.join(process.resourcesPath, "python-runtime", "python.exe");
  const venvPython = path.join(pythonRoot(), ".venv", "Scripts", "python.exe");
  if (fs.existsSync(venvPython)) return venvPython;
  return process.platform === "win32" ? "python" : "python3";
};

/** The Python backend and AudioService this app starts, restarts and stops. */
export class ManagedServices {
  private python: ServiceProcess | null = null;
  private audio: ServiceProcess | null = null;

  constructor(private readonly backendEndpoint: BackendEndpoint) {}

  start(dataRoot: string): void {
    const files = environmentFiles(dataRoot);
    seedEnvironmentFiles(files);
    const executablePath = app.isPackaged
      ? `${path.join(process.resourcesPath, "tools")}${path.delimiter}${process.env.PATH ?? ""}`
      : process.env.PATH;
    this.python = new ServiceProcess(
      pythonExecutable(),
      ["-m", "backend.main"],
      pythonRoot(),
      {
        ...process.env,
        AD_VOICE_DATA: dataRoot,
        AD_VOICE_PORT: process.env.AD_VOICE_PORT ?? "0",
        AD_VOICE_MANAGED: "1",
        AD_VOICE_PROJECT_ENV_FILE: files.project,
        AD_VOICE_ENV_FILE: files.python,
        AD_VOICE_FRONTEND_ENV_FILE: files.frontend,
        AD_VOICE_KAGGLE_ASSETS: path.join(projectRoot(), "kaggle"),
        PYTHONPATH: app.isPackaged ? pythonRoot() : process.env.PYTHONPATH,
        PATH: executablePath,
      },
      this.backendEndpoint,
    );
    this.python.start();

    const executable = audioExecutable();
    if (!fs.existsSync(executable)) {
      console.warn(`AudioService executable not found: ${executable}`);
      return;
    }
    this.audio = new ServiceProcess(executable, [], path.dirname(executable), process.env);
    this.audio.start();
  }

  /** Ends both at once, for a process that is exiting anyway. */
  stop(): void {
    const services = [this.audio, this.python];
    this.audio = null;
    this.python = null;
    for (const service of services) void service?.stop();
  }

  /** Asks each to shut down cleanly (AudioService leaves the room voice first), then ends them. */
  async stopGracefully(): Promise<void> {
    const { audio, python } = this;
    await Promise.allSettled([
      audio?.stop(() => sendAudioRequest({ command: "ShutdownService" })),
      python?.stop(async () => {
        python.endInput();
      }),
      audio ? leaveRoomVoice() : Promise.resolve(),
    ]);
    if (this.audio === audio) this.audio = null;
    if (this.python === python) this.python = null;
  }
}
