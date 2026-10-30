import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(() => ({ unref: () => undefined })) }));
vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "1.1.3", getPath: () => tmpdir(), once: vi.fn() },
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, default: { ...actual, spawn: mocks.spawn }, spawn: mocks.spawn };
});
const { startAutoUpdate } = await import("./AutoUpdate");

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const payload = Buffer.alloc(200_000, 3);
const release = {
  tag_name: "v1.1.5",
  draft: false,
  prerelease: false,
  assets: [
    {
      name: "AD-Voice-Setup.exe",
      size: payload.length,
      browser_download_url: "https://github.com/x/releases/download/v1.1.5/AD-Voice-Setup.exe",
      digest: `sha256:${createHash("sha256").update(payload).digest("hex")}`,
    },
  ],
};

it("launches while the update downloads in the background and installs the cached update next time", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
  const directory = await mkdtemp(path.join(tmpdir(), "updates-"));
  roots.push(directory);
  mocks.spawn.mockClear();
  let finishDownload!: () => void;
  const slow = new Promise<void>((resolve) => (finishDownload = resolve));
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.includes("api.github.com")) return new Response(JSON.stringify(release));
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new Uint8Array(payload.subarray(0, 100_000)));
        await slow;
        controller.enqueue(new Uint8Array(payload.subarray(100_000)));
        controller.close();
      },
    });
    return new Response(body);
  });
  const ready = vi.fn();
  const updater = startAutoUpdate({
    ready,
    log: vi.fn(),
    quit: vi.fn(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    directory,
  });

  expect(await updater.beforeLaunch(() => undefined)).toBe(false);
  expect(fetchImpl).toHaveBeenCalledTimes(0);
  expect(mocks.spawn).not.toHaveBeenCalled();
  // A slow background download must not prevent the already running app from opening.
  await vi.advanceTimersByTimeAsync(31_000);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  finishDownload();
  await vi.waitFor(() => expect(ready).toHaveBeenCalledWith("1.1.5"));
  expect(await updater.beforeLaunch(() => undefined)).toBe(true);
  expect(mocks.spawn).toHaveBeenCalledWith(
    path.join(directory, "AD-Voice-Setup-1.1.5.exe"),
    expect.arrayContaining(["/SILENT"]),
    expect.anything(),
  );
  updater.stop();
});

it("with updates off only offers the new version, and installs it when asked", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "updates-"));
  roots.push(directory);
  mocks.spawn.mockClear();
  const fetchImpl = vi.fn(async (url: string) =>
    url.includes("api.github.com") ? new Response(JSON.stringify(release)) : new Response(new Uint8Array(payload)),
  );
  const available = vi.fn();
  const percents: number[] = [];
  const quit = vi.fn();
  const updater = startAutoUpdate({
    ready: vi.fn(),
    log: vi.fn(),
    quit,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    directory,
    automatic: () => false,
    available,
    progress: (percent) => percents.push(percent),
  });

  // Start-up: nothing is downloaded or installed, the version is offered.
  expect(await updater.beforeLaunch(() => undefined)).toBe(false);
  expect(available).toHaveBeenCalledWith("1.1.5");
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(mocks.spawn).not.toHaveBeenCalled();

  // "Install": downloaded with progress, then the app exits and the installer runs.
  expect(updater.install()).toBe(true);
  await vi.waitFor(() => expect(quit).toHaveBeenCalled());
  expect(percents.at(-1)).toBe(100);
  updater.stop();
});
