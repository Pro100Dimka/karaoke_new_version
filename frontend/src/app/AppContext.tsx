import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Language, RoomStateDto, SettingsTab, ThemeName } from "../contracts/models";
import { audioClient } from "../services/audioClient";
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
  const asioSuspended = useRef(false);
  const asioTransition = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => savePreferences(preferences), [preferences]);
  useEffect(() => {
    document.documentElement.dataset.reducedMotion = String(preferences.reducedMotion);
  }, [preferences.reducedMotion]);
  // Palette tokens live in theme/palettes.css under :root[data-theme="..."].
  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme;
    void desktopClient.setAppIcon(preferences.theme);
  }, [preferences.theme]);
  useEffect(() => {
    const enabled = preferences.releaseAsioInBackground
      && preferences.audio.backend === "ASIO"
      && room === null;
    const setSuspended = (suspended: boolean) => {
      if (asioSuspended.current === suspended) return;
      asioSuspended.current = suspended;
      asioTransition.current = asioTransition.current
        .then(() => suspended ? audioClient.suspendSession() : audioClient.resumeSession())
        .catch(() => { asioSuspended.current = false; });
    };
    const suspend = () => { if (enabled && !settingsOpen) setSuspended(true); };
    const resume = () => setSuspended(false);
    const onWindowState = (state: WindowState) => {
      if (state.minimized && enabled) setSuspended(true);
      else if (!state.minimized) resume();
    };
    window.addEventListener("blur", suspend);
    window.addEventListener("focus", resume);
    const unsubscribeWindowState = desktopClient.onWindowState?.(onWindowState) ?? (() => undefined);
    if (!enabled) resume();
    return () => {
      window.removeEventListener("blur", suspend);
      window.removeEventListener("focus", resume);
      unsubscribeWindowState();
    };
  }, [preferences.audio.backend, preferences.releaseAsioInBackground, room, settingsOpen]);

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
