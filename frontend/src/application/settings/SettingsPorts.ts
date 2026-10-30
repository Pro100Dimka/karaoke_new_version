import type { AudioServiceClient, PythonClient } from "../../contracts/clients";

export type SettingsAudioPort = Pick<AudioServiceClient,
  "runtimeConfiguration" | "listDevices" | "capabilities" |
  "configurationCapabilities" | "applyConfiguration" | "setPreferredConfiguration" |
  "openBackendControlPanel" | "setDspEnabled" | "setDspParameter" |
  "setMixer" | "setMonitoring" |
  "testInputLevel" | "snapshot" | "playTestSound" | "measureAcousticLatency" |
  "diagnosticsDump" | "health">;

export type SettingsBackendPort = Pick<PythonClient,
  "listEnvironmentSettings" | "updateEnvironmentSetting" |
  "verifyEnvironmentSetting" | "verifyKaggleSettings" | "loginKaggle" | "deployKaggle" | "getAiProcessingSettings">;
