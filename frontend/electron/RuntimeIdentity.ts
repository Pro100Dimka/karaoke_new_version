import type { App } from "electron";
import * as path from "node:path";

/** Keeps an installed build and the development checkout independent on the same Windows account. */
export const configureRuntimeIdentity = (app: App): void => {
  const applicationName = app.isPackaged ? "AD Voice" : "AD Voice Dev";
  const appData = app.getPath("appData");
  app.setName(applicationName);
  app.setPath("userData", path.join(appData, applicationName));
  // Models are immutable, checksum-verified multi-gigabyte assets. Both profiles reuse the
  // installed profile's store while songs, settings, recordings, ports and databases stay isolated.
  process.env.AD_VOICE_MODELS ??= path.join(appData, "AD Voice", "backend-data", "models");
  // 8766 collides with another local dev/portable checkout's backend on this machine; 8767 is not one
  // either process already claims for its packaged default, so the two no longer fight over a bind.
  process.env.AD_VOICE_PORT ??= app.isPackaged ? "8765" : "8767";
  process.env.AD_VOICE_AUDIO_ENDPOINT ??= app.isPackaged
    ? String.raw`\\.\pipe\ADVoice.AudioService.v1`
    : String.raw`\\.\pipe\ADVoice.AudioService.Dev.v1`;
};
