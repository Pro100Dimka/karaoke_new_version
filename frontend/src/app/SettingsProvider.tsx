import { createContext, useContext, useMemo, type ReactNode } from "react";
import type {
  SettingsAudioPort,
  SettingsBackendPort,
  SettingsDesktopPort,
  SettingsJobEventsPort,
  SettingsLightingPort,
} from "../application/settings/SettingsPorts";
import { audioClient } from "../services/audioClient";
import { nextJobChange } from "../services/backendEvents";
import { desktopClient } from "../services/desktopClient";
import { keyboardLightingClient } from "../services/keyboardLightingClient";
import { pythonClient } from "../services/pythonClient";

export type SettingsPorts = {
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

export const SettingsProvider = ({
  children,
  value,
}: {
  children: ReactNode;
  value?: Partial<SettingsPorts>;
}) => {
  const ports = useMemo(
    () => (value ? { ...implementations, ...value } : implementations),
    [value],
  );
  return (
    <SettingsContext.Provider value={ports}>
      {children}
    </SettingsContext.Provider>
  );
};

const useSettingsPorts = () => useContext(SettingsContext) ?? implementations;

export const useSettingsAudio = () => useSettingsPorts().audio;
export const useSettingsBackend = () => useSettingsPorts().backend;
export const useSettingsDesktop = () => useSettingsPorts().desktop;
export const useSettingsLighting = () => useSettingsPorts().lighting;
export const useSettingsJobEvents = () => useSettingsPorts().jobs;
