import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false, getVersion: () => "1.1.1" } }));
const { fetchInstaller } = await import("./AutoUpdate");

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const payload = Buffer.alloc(300_000, 7);
const release = (sha256 = createHash("sha256").update(payload).digest("hex")) => ({
  version: "1.2.0",
  url: "https://github.com/x/releases/download/v1.2.0/AD-Voice-Setup.exe",
  size: payload.length,
  sha256,
});
const serve = () => vi.fn(async () => new Response(new Uint8Array(payload)));

it("downloads the installer with progress and reuses the verified file at the next start", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "updates-"));
  roots.push(directory);
  const fetchImpl = serve();
  const percents: number[] = [];

  const file = await fetchInstaller(fetchImpl as unknown as typeof fetch, release(), directory, (percent) => percents.push(percent));

  expect(file).toBe(path.join(directory, "AD-Voice-Setup-1.2.0.exe"));
  expect(await readFile(file!)).toEqual(payload);
  expect(percents.at(-1)).toBe(100);
  expect(percents).toEqual([...percents].sort((a, b) => a - b));

  expect(await fetchInstaller(fetchImpl as unknown as typeof fetch, release(), directory)).toBe(file);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it("throws away an installer that does not match the release", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "updates-"));
  roots.push(directory);

  const file = await fetchInstaller(serve() as unknown as typeof fetch, release("0".repeat(64)), directory);

  expect(file).toBeNull();
  expect(await readdir(directory)).toEqual([]);
});
