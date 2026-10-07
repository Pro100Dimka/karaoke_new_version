import type { AudioServiceClient, DesktopClient, PythonClient } from "../../contracts/clients";
import type { ThemeName } from "../../contracts/models";
import type { KeyboardLightingPreferences } from "../../shared/preferences/preferences";

export type SettingsAudioPort = Pick<AudioServiceClient,
  "runtimeConfiguration" | "listDevices" | "capabilities" |
  "configurationCapabilities" | "applyConfiguration" | "setPreferredConfiguration" |
  "openBackendControlPanel" | "setDspEnabled" | "setDspParameter" |
  "setMixer" | "setMonitoring" |
  "testInputLevel" | "playTestSound" | "measureAcousticLatency" |
  "diagnosticsDump" | "health">;

export type SettingsBackendPort = Pick<PythonClient,
  "listModels" | "diagnostics" | "getAiProcessingSettings" | "getJob" |
  "downloadModel" | "cancelJob" | "updateAiProcessingSettings" |
  "clearCache" | "clearTemporaryFiles" | "history" | "listSongs" |
  "listEnvironmentSettings" | "updateEnvironmentSetting" |
  "verifyEnvironmentSetting" | "verifyKaggleSettings" | "loginKaggle" |
  "deployKaggle">;

export type SettingsDesktopPort = Pick<DesktopClient,
  "getStorageRoot" | "pickStorageFolder" | "setStorageRoot" | "pathForFile" |
  "copyText" | "saveTextFile" | "installAsio4All" | "relaunchApp" |
  "openMicrophonePrivacy" | "keyboardLightingCapabilities">;

export type SettingsLightingPort = {
  capabilities(): Promise<KeyboardLightingCapabilities>;
  apply(preferences: KeyboardLightingPreferences, theme: ThemeName,
    positionSeconds?: number): Promise<void>;
};

export type SettingsJobEventsPort = {
  next(jobId: string, pollMilliseconds: number): Promise<void>;
};
