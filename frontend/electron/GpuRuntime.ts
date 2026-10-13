import * as path from "node:path";

/** Must match TORCH_VERSION and the CUDA wheels in python/backend/infrastructure/torch_runtime.py. */
export const gpuRuntimeName = "torch-2.11.0-cu130";

/**
 * Where the backend places the CUDA build of PyTorch on an NVIDIA computer (the installer carries
 * the CPU build): the user's profile, writable without elevation. The backend fetches it in the
 * background and uses it for the next job on its own; nothing here has to wait or restart.
 */
export const gpuRuntimeDir = (userData: string): string =>
  path.join(userData, "gpu-runtime", gpuRuntimeName);
