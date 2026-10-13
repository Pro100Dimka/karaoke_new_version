import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { expect, it } from "vitest";
import { gpuRuntimeDir, gpuRuntimeName } from "./GpuRuntime";

it("keeps the CUDA build in the user's profile, named after the build the backend downloads", async () => {
  expect(gpuRuntimeDir("C:/Users/me/AppData/Roaming/AD Voice")).toBe(
    path.join("C:/Users/me/AppData/Roaming/AD Voice", "gpu-runtime", gpuRuntimeName),
  );
  const python = await readFile(
    path.join(__dirname, "..", "..", "python", "backend", "infrastructure", "torch_runtime.py"),
    "utf8",
  );
  const version = /TORCH_VERSION = "([^"]+)"/.exec(python)?.[1];
  expect(gpuRuntimeName).toBe(`torch-${version}-cu130`);
  expect(python).toContain('_wheel("cu130", "torch"');
});
