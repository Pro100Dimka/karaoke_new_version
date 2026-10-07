import { createContext, useContext, type ReactNode } from "react";
import type {
  SettingsAudioPort, SettingsBackendPort, SettingsDesktopPort,
  SettingsJobEventsPort, SettingsLightingPort,
} from "../application/settings/SettingsPorts";
import { audioClient } from "../services/audioClient";
import { nextJobChange } from "../services/backendEvents";
import { desktopClient } from "../services/desktopClient";
import { keyboardLightingClient } from "../services/keyboardLightingClient";
import { pythonClient } from "../services/pythonClient";

type SettingsPorts = {
  audio: SettingsAudioPort;
  backend: SettingsBackendPort;
  desktop: SettingsDesktopPort;
  lighting: SettingsLightingPort;
  jobs: SettingsJobEventsPort;
};
const implementations: SettingsPorts = {
  audio: audioClient,
  backend: pythonClient,
  desktop: desktopClient,
  lighting: keyboardLightingClient,
  jobs: { next: nextJobChange },
};
const SettingsContext = createContext<SettingsPorts | null>(null);

export const SettingsProvider = ({ children }: { children: ReactNode }) =>
  <SettingsContext.Provider value={implementations}>{children}</SettingsContext.Provider>;

const useSettingsPorts = (): SettingsPorts => {
  const ports = useContext(SettingsContext);
  if (!ports) throw new Error("SettingsProvider is missing");
  return ports;
};

export const useSettingsAudio = (): SettingsAudioPort => useSettingsPorts().audio;
export const useSettingsBackend = (): SettingsBackendPort => useSettingsPorts().backend;
export const useSettingsDesktop = (): SettingsDesktopPort => useSettingsPorts().desktop;
export const useSettingsLighting = (): SettingsLightingPort => useSettingsPorts().lighting;
export const useSettingsJobEvents = (): SettingsJobEventsPort => useSettingsPorts().jobs;
