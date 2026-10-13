import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Must match TORCH_VERSION and the CUDA wheels in python/backend/infrastructure/torch_runtime.py. */
export const gpuRuntimeName = "torch-2.11.0-cu130";

/** Where the CUDA build of PyTorch is placed: the user's profile, writable without elevation. */
export const gpuRuntimeDir = (userData: string): string =>
  path.join(userData, "gpu-runtime", gpuRuntimeName);

/** Present only once every file is unpacked (the folder is renamed into place when complete). */
export const gpuRuntimeReady = (dir: string): boolean =>
  fs.existsSync(path.join(dir, ".complete"));

/**
 * The backend's import path: a complete CUDA build comes first and shadows the CPU build the
 * installer carries; otherwise the CPU build is used.
 */
export const backendPythonPath = (pythonRoot: string, gpuDir: string): string =>
  gpuRuntimeReady(gpuDir) ? [gpuDir, pythonRoot].join(path.delimiter) : pythonRoot;

/** An NVIDIA GPU with its driver: `nvidia-smi -L` lists it ("GPU 0: …"). */
export const hasNvidiaGpu = (): Promise<boolean> =>
  new Promise((resolve) =>
    execFile("nvidia-smi", ["-L"], { windowsHide: true, timeout: 15_000 }, (error, stdout) =>
      resolve(!error && /^GPU \d+:/m.test(String(stdout))),
    ),
  );

interface GpuRuntimeInstall {
  python: string;
  pythonRoot: string;
  dir: string;
  env: NodeJS.ProcessEnv;
  log(level: string, message: string): void;
  started(): void;
  finished(ok: boolean): void;
}

/**
 * On an NVIDIA computer without the CUDA build yet, downloads it in the background (about 2.5 GB,
 * verified by SHA-256) while processing keeps running on the CPU; it is used from the next start.
 * A failed attempt is simply tried again at the next start.
 */
export const installGpuRuntimeInBackground = async (options: GpuRuntimeInstall): Promise<void> => {
  if (gpuRuntimeReady(options.dir) || !(await hasNvidiaGpu())) return;
  options.started();
  options.log("info", `Downloading the CUDA build of PyTorch into ${options.dir}`);
  const child = spawn(
    options.python,
    ["-m", "backend.infrastructure.torch_runtime", "install-gpu", options.dir],
    { cwd: options.pythonRoot, env: options.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (data: Buffer) => options.log("info", String(data)));
  child.stderr.on("data", (data: Buffer) => options.log("error", String(data)));
  child.on("error", (error) => {
    options.log("error", `CUDA build download could not start: ${error.message}`);
    options.finished(false);
  });
  child.on("exit", (code) => {
    const ok = code === 0 && gpuRuntimeReady(options.dir);
    options.log(ok ? "info" : "error", ok ? "CUDA build of PyTorch is ready" : `CUDA build download failed (exit ${code})`);
    options.finished(ok);
  });
};
