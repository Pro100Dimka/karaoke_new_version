import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { launchAsio4AllInstaller, type Asio4AllRelease } from "./Asio4AllInstaller";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

const setup = async (bytes: Uint8Array): Promise<{ root: string; release: Asio4AllRelease }> => {
  const root = await mkdtemp(join(tmpdir(), "asio4all-test-"));
  roots.push(root);
  return {
    root,
    release: {
      version: "test",
      url: "https://asio4all.org/downloads/test.exe",
      fileName: "test.exe",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
};

it("downloads a verified official installer before launching it", async () => {
  const bytes = new TextEncoder().encode("signed installer fixture");
  const { root, release } = await setup(bytes);
  const openPath = vi.fn(async () => "");
  await launchAsio4AllInstaller(root, openPath, release, vi.fn(async () => new Response(bytes)));
  const installer = join(root, release.fileName);
  expect(await readFile(installer)).toEqual(Buffer.from(bytes));
  expect(openPath).toHaveBeenCalledWith(installer);
});

it("never launches a download whose checksum does not match the pinned release", async () => {
  const bytes = new TextEncoder().encode("tampered");
  const { root, release } = await setup(bytes);
  release.sha256 = "0".repeat(64);
  const openPath = vi.fn(async () => "");
  await expect(launchAsio4AllInstaller(root, openPath, release,
    vi.fn(async () => new Response(bytes)))).rejects.toThrow(/checksum/i);
  expect(openPath).not.toHaveBeenCalled();
});
