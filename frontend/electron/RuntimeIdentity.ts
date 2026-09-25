import type { App } from "electron";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { isSafePathComponent } from "./PathPolicy";

/** Keeps an installed build and the development checkout independent on the same Windows account. */
export const configureRuntimeIdentity = (app: App): void => {
  const defaultName = app.isPackaged ? "AD Voice" : "AD Voice Dev";
  const requestedProfile = process.env.AD_VOICE_PROFILE?.trim();
  const applicationName = requestedProfile && /^[\p{L}\p{N} ._-]{1,64}$/u.test(requestedProfile) && isSafePathComponent(requestedProfile)
    ? requestedProfile
    : defaultName;
  const appData = app.getPath("appData");
  app.setName(applicationName);
  app.setPath("userData", path.join(appData, applicationName));
  // Models are immutable, checksum-verified multi-gigabyte assets. Both profiles reuse the
  // installed profile's store while songs, settings, recordings, ports and databases stay isolated.
  process.env.AD_VOICE_MODELS ??= path.join(appData, "AD Voice", "backend-data", "models");
  process.env.AD_VOICE_PORT ??= "0";
  const defaultEndpoint = app.isPackaged ? String.raw`\\.\pipe\ADVoice.AudioService.v1` : String.raw`\\.\pipe\ADVoice.AudioService.Dev.v1`;
  const profileId = createHash("sha256").update(path.join(appData, applicationName).toLowerCase()).digest("hex").slice(0, 24);
  process.env.AD_VOICE_AUDIO_ENDPOINT ??= applicationName === defaultName
    ? defaultEndpoint : String.raw`\\.\pipe\ADVoice.AudioService.Profile.${profileId}.v1`;
};
