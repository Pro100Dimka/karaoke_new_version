import type { App } from "electron";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { isSafePathComponent } from "./PathPolicy";

/** Keeps an installed build and the development checkout independent on the same Windows account. */
export const configureRuntimeIdentity = (app: App): void => {
  const defaultName = app.isPackaged ? "AD Voice" : "AD Voice Dev";
  const requestedProfile = process.env.AD_VOICE_PROFILE?.trim();
  const applicationName =
    requestedProfile &&
    /^[\p{L}\p{N} ._-]{1,64}$/u.test(requestedProfile) &&
    isSafePathComponent(requestedProfile)
      ? requestedProfile
      : defaultName;
  const installedRoot = path.dirname(process.execPath);
  const configuredRoot = app.isPackaged
    ? path.join(installedRoot, "data")
    : process.env.AD_VOICE_PROFILE_ROOT?.trim();
  if (configuredRoot && !path.isAbsolute(configuredRoot))
    throw new Error("AD_VOICE_PROFILE_ROOT must be an absolute path");
  const appData = configuredRoot || app.getPath("appData");
  const userData = path.join(appData, applicationName);
  if (app.isPackaged) {
    mkdirSync(appData, { recursive: true });
    const relative = path.relative(realpathSync(installedRoot), realpathSync(appData));
    if (relative.split(path.sep).includes("..") || path.isAbsolute(relative))
      throw new Error("Application data must stay inside the installation directory");
    if (existsSync(path.join(appData, ".storage-migration")))
      throw new Error("Data migration is incomplete. Run the installer again to resume it.");
    const legacy = path.join(app.getPath("appData"), applicationName);
    const prepared = ["storage-layout.json", ".storage-cleanup"].some((name) => existsSync(path.join(appData, name)));
    if (!existsSync(legacy) && !prepared) {
      try {
        lstatSync(legacy);
        throw new Error(`Legacy application data is unavailable: ${legacy}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (existsSync(legacy) && realpathSync(legacy) !== path.resolve(userData) && !prepared)
      throw new Error("Data migration must finish before this version opens. Run the installer again.");
  }
  const ensureDirectory = (folder: string): void => {
    if (app.isPackaged) {
      let existing = folder;
      while (!existsSync(existing)) {
        const parent = path.dirname(existing);
        if (parent === existing) throw new Error(`Application data directory is unavailable: ${folder}`);
        existing = parent;
      }
      const relative = path.relative(realpathSync(installedRoot), realpathSync(existing));
      if (relative.split(path.sep).includes("..") || path.isAbsolute(relative))
        throw new Error("Application data must stay inside the installation directory");
    }
    mkdirSync(folder, { recursive: true });
  };
  app.setName(applicationName);
  const runtimePaths = [
    ["userData", userData],
    ...(configuredRoot ? [
      ["appData", appData],
      ["sessionData", userData],
      ["temp", path.join(appData, "temp")],
      ["logs", path.join(userData, "logs")],
      ["crashDumps", path.join(userData, "Crashpad")],
    ] as const : []),
  ] as const;
  for (const [name, folder] of runtimePaths) {
    if (configuredRoot) ensureDirectory(folder);
    app.setPath(name, folder);
  }
  if (configuredRoot) Object.assign(process.env, {
    TEMP: path.join(appData, "temp"),
    TMP: path.join(appData, "temp"),
    NUMBA_CACHE_DIR: path.join(appData, "cache", "numba"),
    AD_VOICE_MODELS: path.join(appData, "AD Voice", "backend-data", "models"),
  });
  process.env.AD_VOICE_FIXED_STORAGE = app.isPackaged ? "1" : "0";
  if (app.isPackaged) {
    const caches = Object.fromEntries(Object.entries({
      TORCH_HOME: "torch", TORCH_EXTENSIONS_DIR: "torch-extensions", HF_HOME: "huggingface",
      HF_HUB_CACHE: "huggingface/hub", HUGGINGFACE_HUB_CACHE: "huggingface/hub",
      XDG_CACHE_HOME: "", PIP_CACHE_DIR: "pip", CUDA_CACHE_PATH: "cuda",
      NODE_COMPILE_CACHE: "node", PYTHONPYCACHEPREFIX: "python",
    }).map(([name, folder]) => [name, path.join(appData, "cache", folder)]));
    for (const folder of new Set(Object.values(caches))) ensureDirectory(folder);
    ensureDirectory(path.join(appData, "AD Voice", "backend-data", "models"));
    Object.assign(process.env, {
      AD_VOICE_PROFILE_ROOT: appData,
      AD_VOICE_DATA: path.join(userData, "backend-data"),
      ...caches,
    });
  }
  // Models are immutable, checksum-verified multi-gigabyte assets. Both profiles reuse the
  // installed profile's store while songs, settings, recordings, ports and databases stay isolated.
  process.env.AD_VOICE_MODELS ??= path.join(
    appData,
    "AD Voice",
    "backend-data",
    "models",
  );
  process.env.AD_VOICE_PORT ??= "0";
  const defaultEndpoint = app.isPackaged
    ? String.raw`\\.\pipe\ADVoice.AudioService.v1`
    : String.raw`\\.\pipe\ADVoice.AudioService.Dev.v1`;
  const profileId = createHash("sha256")
    .update(path.join(appData, applicationName).toLowerCase())
    .digest("hex")
    .slice(0, 24);
  process.env.AD_VOICE_AUDIO_ENDPOINT ??=
    applicationName === defaultName
      ? defaultEndpoint
      : String.raw`\\.\pipe\ADVoice.AudioService.Profile.${profileId}.v1`;
};
