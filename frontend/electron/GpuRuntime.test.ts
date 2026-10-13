import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { backendPythonPath, gpuRuntimeDir, gpuRuntimeName } from "./GpuRuntime";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("puts the CUDA build before the bundled one only once it is complete", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "gpu-runtime-"));
  roots.push(userData);
  const dir = gpuRuntimeDir(userData);
  expect(dir).toBe(path.join(userData, "gpu-runtime", gpuRuntimeName));

  expect(backendPythonPath("app", dir)).toBe("app");
  await mkdir(dir, { recursive: true });
  expect(backendPythonPath("app", dir)).toBe("app");
  await writeFile(path.join(dir, ".complete"), "2.11.0");
  expect(backendPythonPath("app", dir)).toBe([dir, "app"].join(path.delimiter));
});

it("names the same PyTorch build the backend downloads", async () => {
  const { readFile } = await import("node:fs/promises");
  const python = await readFile(
    path.join(__dirname, "..", "..", "python", "backend", "infrastructure", "torch_runtime.py"),
    "utf8",
  );
  const version = /TORCH_VERSION = "([^"]+)"/.exec(python)?.[1];
  expect(gpuRuntimeName).toBe(`torch-${version}-cu130`);
  expect(python).toContain('_wheel("cu130", "torch"');
});
