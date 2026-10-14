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
/**
 * The full installer. "AD-Voice-Setup.exe" is a small one that downloads it (installer/
 * ad-voice-web.iss), for versions 1.1.2-1.1.5 that cannot download a large one; this app takes the
 * full one directly, so its download shows on the start-up screen.
 */
export const fullInstallerAssetName = "AD-Voice-Setup-Full.exe";
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
  const named = (name: string) =>
    assets.find(
      (item): item is Record<string, unknown> => !!item && typeof item === "object" && (item as Record<string, unknown>).name === name,
    );
  const asset = named(fullInstallerAssetName) ?? named(installerAssetName);
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

/** What the start-up screen shows while an update is put in place before the app opens. */
export type LaunchUpdateState =
  | { phase: "checking" }
  | { phase: "downloading"; version: string; percent: number }
  | { phase: "installing"; version: string };

interface UpdaterOptions {
  /** A newer version was downloaded and verified while the app runs: it installs at the next start. */
  ready: (version: string) => void;
  /** Whether updates install by themselves (Settings); off, a newer version is only announced. */
  automatic?: () => boolean;
  /** Updates are off and a newer version exists: the interface offers to install it. */
  available?: (version: string) => void;
  /** "Install" was chosen: how far its download is, 0..100. */
  progress?: (percent: number) => void;
  /** "Install" was chosen but the download failed or did not match the release. */
  installFailed?: () => void;
  log: (level: "info" | "warning", message: string) => void;
  /** Starts the app's normal exit; the installer runs once it has finished. */
  quit: () => void;
  fetchImpl?: typeof fetch;
  /** Where installers wait between launches (default: the profile's "updates" folder). */
  directory?: string;
}

/** The newer release's installer, or undefined when there is none or GitHub cannot be reached in time. */
const latestInstaller = async (fetchImpl: typeof fetch, timeoutMilliseconds: number) => {
  const response = await fetchImpl(`https://api.github.com/repos/${updateRepository}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "AD-Voice-Updater" },
    signal: AbortSignal.timeout(timeoutMilliseconds),
  });
  return response.ok ? installerFromRelease(await response.json(), app.getVersion()) : undefined;
};

/**
 * The installer as a verified file in `directory`: one downloaded earlier is reused when its
 * recorded SHA-256 and size still match the release, otherwise it is downloaded (older ones go).
 * Null when the download fails or does not match the release.
 */
export const fetchInstaller = async (
  fetchImpl: typeof fetch,
  installer: ReleaseInstaller,
  directory: string,
  onPercent: (percent: number) => void = () => undefined,
): Promise<string | null> => {
  const file = path.join(directory, `AD-Voice-Setup-${installer.version}.exe`);
  const record = `${file}.sha256`;
  const expected = installer.sha256 ?? `size:${installer.size}`;
  try {
    if (fs.statSync(file).size === installer.size && fs.readFileSync(record, "utf8") === expected) return file;
  } catch {
    // Not downloaded yet.
  }
  fs.mkdirSync(directory, { recursive: true });
  // Older installers go; one still held open (the antivirus scanning it) is simply left for later.
  for (const name of fs.readdirSync(directory))
    if (!name.startsWith(path.basename(file)))
      try {
        fs.rmSync(path.join(directory, name), { force: true });
      } catch {
        // Removed at a later update.
      }
  const download = await fetchImpl(installer.url, { signal: AbortSignal.timeout(60 * 60_000) });
  if (!download.ok || !download.body) return null;
  const hash = createHash("sha256");
  let size = 0;
  let shown = -1;
  await pipeline(
    Readable.fromWeb(download.body as import("node:stream/web").ReadableStream),
    async function* (chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        hash.update(chunk);
        size += chunk.length;
        const percent = Math.min(100, Math.floor((size * 100) / installer.size));
        if (percent !== shown) onPercent((shown = percent));
        yield chunk;
      }
    },
    fs.createWriteStream(`${file}.part`),
  );
  if (size !== installer.size || (installer.sha256 && hash.digest("hex") !== installer.sha256)) {
    fs.rmSync(`${file}.part`, { force: true });
    return null;
  }
  fs.renameSync(`${file}.part`, file);
  fs.writeFileSync(record, expected);
  return file;
};

/** Runs a verified installer silently, after this app has exited; the installer starts the app again. */
const runInstaller = (file: string): void => {
  spawn(file, ["/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CLOSEAPPLICATIONS"], {
    detached: true,
    stdio: "ignore",
  }).unref();
};

/**
 * Updates from GitHub Releases, as in Discord: before the app opens it checks for a newer version
 * and, when there is one, downloads it (with progress on the start-up screen), installs it
 * silently and opens the new version. While the app runs it fetches newer versions ahead, so the
 * next start only installs. Without a connection the app simply opens. Every installer is checked
 * against the release's size and SHA-256. Only the installed app updates itself.
 */
export const startAutoUpdate = ({
  ready,
  log,
  quit,
  fetchImpl = fetch,
  directory,
  automatic = () => true,
  available = () => undefined,
  progress: downloadProgress = () => undefined,
  installFailed = () => undefined,
}: UpdaterOptions) => {
  if (!app.isPackaged)
    return { beforeLaunch: async () => false, install: () => false, stop: () => undefined, scheduleChecks: () => undefined };
  const updates = directory ?? path.join(app.getPath("userData"), "updates");
  let downloaded: { version: string; file: string } | null = null;
  // With updates off: the newer release found, installed only when the user chooses to.
  let offered: ReleaseInstaller | null = null;
  let checking = false;
  const failed = (error: unknown) =>
    log("warning", `Update check failed: ${error instanceof Error ? error.message : String(error)}`);

  const offer = (installer: ReleaseInstaller) => {
    if (offered?.version === installer.version) return;
    offered = installer;
    log("info", `Update ${installer.version} is available; updates are installed by hand`);
    available(installer.version);
  };

  const check = async () => {
    if (checking || downloaded) return;
    checking = true;
    try {
      const installer = await latestInstaller(fetchImpl, 15_000);
      if (!installer) return;
      if (!automatic()) return offer(installer);
      const file = await fetchInstaller(fetchImpl, installer, updates);
      if (!file) return log("warning", `Update ${installer.version} discarded: size or SHA-256 does not match the release`);
      downloaded = { version: installer.version, file };
      log("info", `Update ${installer.version} downloaded and verified`);
      ready(installer.version);
    } catch (error) {
      failed(error);
    } finally {
      checking = false;
    }
  };

  // The checks while the app runs begin only once the check before launch is over: two downloads
  // of the same installer at once removed each other's file, and no update was ever installed.
  let first: NodeJS.Timeout | undefined;
  let timer: NodeJS.Timeout | undefined;
  const scheduleChecks = () => {
    if (first) return;
    first = setTimeout(() => void check(), 30_000);
    timer = setInterval(() => void check(), checkEveryMilliseconds);
    first.unref();
    timer.unref();
  };

  return {
    /**
     * Before the app opens: installs a newer version (downloading it first if needed) and reports
     * true once the installer has taken over; false opens the app as usual.
     */
    async beforeLaunch(progress: (state: LaunchUpdateState) => void): Promise<boolean> {
      checking = true;
      try {
        progress({ phase: "checking" });
        const installer = await latestInstaller(fetchImpl, 5_000);
        if (!installer) return false;
        // Updates off: nothing is downloaded or installed; the Library offers the new version.
        if (!automatic()) {
          offer(installer);
          return false;
        }
        const { version } = installer;
        const file = await fetchInstaller(fetchImpl, installer, updates, (percent) =>
          progress({ phase: "downloading", version, percent }),
        );
        if (!file) return false;
        progress({ phase: "installing", version });
        log("info", `Installing update ${version} before start`);
        runInstaller(file);
        return true;
      } catch (error) {
        failed(error);
        return false;
      } finally {
        checking = false;
        scheduleChecks();
      }
    },
    /**
     * "Update now" / "Install": the app exits, the installer runs and opens the new version. An
     * offered version is downloaded first (its progress is reported); false when there is none.
     */
    install(): boolean {
      const exitAndInstall = (file: string) => {
        app.once("will-quit", () => runInstaller(file));
        quit();
      };
      if (downloaded) {
        exitAndInstall(downloaded.file);
        return true;
      }
      const installer = offered;
      if (!installer || checking) return false;
      checking = true;
      void fetchInstaller(fetchImpl, installer, updates, downloadProgress)
        .then((file) => {
          if (!file) throw new Error("size or SHA-256 does not match the release");
          downloaded = { version: installer.version, file };
          exitAndInstall(file);
        })
        .catch((error: unknown) => {
          failed(error);
          installFailed();
        })
        .finally(() => {
          checking = false;
        });
      return true;
    },
    stop(): void {
      clearTimeout(first);
      clearInterval(timer);
    },
    /** Starts the checks while the app runs without a check before launch (tests, embedders). */
    scheduleChecks,
  };
};
