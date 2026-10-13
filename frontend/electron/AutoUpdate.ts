import { app } from "electron";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Where releases are published: GitHub Releases of this repository, with the installer attached. */
export const updateRepository = "Pro100Dimka/karaoke_new_version";
export const installerAssetName = "AD-Voice-Setup.exe";
const checkEveryMilliseconds = 6 * 60 * 60 * 1000;

/** `1.2.10` > `1.2.9`; a leading `v` and anything after `-`/`+` are ignored. */
export const isNewerVersion = (candidate: string, current: string): boolean => {
  const parts = (value: string) =>
    value.trim().replace(/^v/i, "").split(/[-+]/)[0]!.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parts(candidate), parts(current)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference > 0;
  }
  return false;
};

export interface ReleaseInstaller {
  version: string;
  url: string;
  size: number;
  /** Hex SHA-256 as GitHub reports it for the asset, when it does. */
  sha256?: string;
}

/** The installer of GitHub's "latest release" response, if it is newer than this app. */
export const installerFromRelease = (release: unknown, currentVersion: string): ReleaseInstaller | undefined => {
  if (!release || typeof release !== "object") return undefined;
  const { tag_name: tag, draft, prerelease, assets } = release as Record<string, unknown>;
  if (typeof tag !== "string" || draft === true || prerelease === true || !Array.isArray(assets)) return undefined;
  if (!isNewerVersion(tag, currentVersion)) return undefined;
  const asset = assets.find(
    (item): item is Record<string, unknown> => !!item && typeof item === "object" && (item as Record<string, unknown>).name === installerAssetName,
  );
  if (!asset || typeof asset.browser_download_url !== "string" || typeof asset.size !== "number") return undefined;
  const url = new URL(asset.browser_download_url);
  // Only GitHub's own download hosts: a tampered response cannot point the updater elsewhere.
  if (url.protocol !== "https:" || !["github.com", "objects.githubusercontent.com"].includes(url.hostname)) return undefined;
  const digest = typeof asset.digest === "string" ? /^sha256:([0-9a-f]{64})$/i.exec(asset.digest)?.[1] : undefined;
  return {
    version: tag.replace(/^v/i, ""),
    url: url.toString(),
    size: asset.size,
    ...(digest ? { sha256: digest.toLowerCase() } : {}),
  };
};

interface UpdaterOptions {
  /** A downloaded, verified installer is ready: it installs at exit, or now if the user asks. */
  ready: (version: string) => void;
  log: (level: "info" | "warning", message: string) => void;
  /** Starts the app's normal exit; the installer runs once it has finished. */
  quit: () => void;
  fetchImpl?: typeof fetch;
}

/**
 * Updates from GitHub Releases: checks at start-up and every few hours, downloads a newer
 * installer in the background and verifies its size and SHA-256. It then installs silently when
 * the app is closed, with nothing to click; "Update now" installs it right away and starts the app
 * again. Only the installed app updates itself.
 */
/** Runs a verified installer silently, after this app has exited. */
const runInstaller = (file: string, relaunch: boolean): void => {
  spawn(
    file,
    ["/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CLOSEAPPLICATIONS", ...(relaunch ? [] : ["/NORELAUNCH"])],
    { detached: true, stdio: "ignore" },
  ).unref();
};

export const startAutoUpdate = ({ ready, log, quit, fetchImpl = fetch }: UpdaterOptions) => {
  if (!app.isPackaged) return { install: () => false, stop: () => undefined };
  let downloaded: { version: string; file: string } | null = null;
  let checking = false;
  // Closing the app installs the update without starting it again; "Update now" starts it again.
  let relaunch = false;

  const check = async () => {
    if (checking || downloaded) return;
    checking = true;
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${updateRepository}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "AD-Voice-Updater" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return;
      const installer = installerFromRelease(await response.json(), app.getVersion());
      if (!installer) return;
      const file = path.join(app.getPath("temp"), `AD-Voice-Setup-${installer.version}.exe`);
      const download = await fetchImpl(installer.url, { signal: AbortSignal.timeout(30 * 60_000) });
      if (!download.ok || !download.body) return;
      const hash = createHash("sha256");
      let size = 0;
      await pipeline(
        Readable.fromWeb(download.body as import("node:stream/web").ReadableStream),
        async function* (chunks: AsyncIterable<Buffer>) {
          for await (const chunk of chunks) {
            hash.update(chunk);
            size += chunk.length;
            yield chunk;
          }
        },
        fs.createWriteStream(file),
      );
      const sha256 = hash.digest("hex");
      if (size !== installer.size || (installer.sha256 && sha256 !== installer.sha256)) {
        fs.rmSync(file, { force: true });
        log("warning", `Update ${installer.version} discarded: size or SHA-256 does not match the release`);
        return;
      }
      downloaded = { version: installer.version, file };
      app.once("will-quit", () => runInstaller(file, relaunch));
      log("info", `Update ${installer.version} downloaded and verified`);
      ready(installer.version);
    } catch (error) {
      log("warning", `Update check failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      checking = false;
    }
  };

  const first = setTimeout(() => void check(), 30_000);
  const timer = setInterval(() => void check(), checkEveryMilliseconds);
  first.unref();
  timer.unref();

  return {
    /** Installs the verified update now: the app exits, the installer runs and starts it again. */
    install(): boolean {
      if (!downloaded) return false;
      relaunch = true;
      quit();
      return true;
    },
    stop(): void {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
};
