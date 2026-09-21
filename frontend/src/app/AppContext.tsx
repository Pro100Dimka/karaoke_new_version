import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Language, RoomStateDto, SettingsTab, ThemeName } from "../contracts/models";
import { desktopClient } from "../services/desktopClient";
import {
  loadPreferences,
  savePreferences,
  type Preferences
} from "../shared/preferences/preferences";

interface AppContextValue {
  theme: ThemeName;
  language: Language;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  room: RoomStateDto | null;
  preferences: Preferences;
  setTheme(value: ThemeName): void;
  setLanguage(value: Language): void;
  setSettingsOpen(value: boolean): void;
  openSettings(tab?: SettingsTab): void;
  setRoom(value: RoomStateDto | null): void;
  updatePreferences(patch: Partial<Preferences>): void;
}

const AppContext = createContext<AppContextValue | null>(null);

export const AppProvider = ({ children }: { children: ReactNode }) => {
  const [preferences, setPreferences] = useState<Preferences>(loadPreferences);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("appearance");
  const [room, setRoom] = useState<RoomStateDto | null>(null);

  useEffect(() => savePreferences(preferences), [preferences]);
  useEffect(() => {
    document.documentElement.dataset.reducedMotion = String(preferences.reducedMotion);
  }, [preferences.reducedMotion]);
  // Palette tokens live in theme/palettes.css under :root[data-theme="..."].
  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme;
    void desktopClient.setAppIcon(preferences.theme);
  }, [preferences.theme]);

  const value = useMemo<AppContextValue>(
    () => ({
      theme: preferences.theme,
      language: preferences.language,
      settingsOpen,
      settingsTab,
      room,
      preferences,
      setTheme: theme => setPreferences(current => ({ ...current, theme })),
      setLanguage: language => setPreferences(current => ({ ...current, language })),
      setSettingsOpen,
      openSettings: (tab = "appearance") => {
        setSettingsTab(tab);
        setSettingsOpen(true);
      },
      setRoom,
      updatePreferences: patch => setPreferences(current => ({ ...current, ...patch }))
    }),
    [preferences, settingsOpen, settingsTab, room]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

export const useApp = (): AppContextValue => {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside AppProvider");
  return value;
};
