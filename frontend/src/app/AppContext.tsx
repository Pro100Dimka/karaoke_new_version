import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { applyAppFonts } from "../shared/preferences/appFonts";
import type { Language, RoomStateDto, SettingsTab, ThemeName } from "../contracts/models";
import { audioClient } from "../services/audioClient";
import { desktopClient } from "../services/desktopClient";
import { useAppOnScreen } from "./useAppOnScreen";
import {
  loadPreferences,
  savePreferences,
  type Preferences
} from "../shared/preferences/preferences";

interface AppContextValue {
  theme: ThemeName;
  language: Language;
  room: RoomStateDto | null;
  preferences: Preferences;
  setTheme(value: ThemeName): void;
  setLanguage(value: Language): void;
  /** Opens the settings dialog; stable, so a button holding it never redraws when the dialog opens. */
  openSettings(tab?: SettingsTab): void;
  setRoom(value: RoomStateDto | null): void;
  updatePreferences(patch: Partial<Preferences>): void;
}

/** Whether the settings dialog is open and on which tab: read only by the dialog itself. */
interface SettingsDialogValue {
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  setSettingsOpen(value: boolean): void;
}

const AppContext = createContext<AppContextValue | null>(null);
// Kept apart from the app context: opening or closing the dialog must not redraw every screen that reads the app
// context (the library grid, karaoke, the room panel...), only the dialog.
const SettingsDialogContext = createContext<SettingsDialogValue | null>(null);

export const AppProvider = ({ children }: { children: ReactNode }) => {
  const [preferences, setPreferences] = useState<Preferences>(loadPreferences);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("appearance");
  const [room, setRoom] = useState<RoomStateDto | null>(null);
  const asioSuspended = useRef(false);
  const asioTransition = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => savePreferences(preferences), [preferences]);
  // The kit's looping effects follow data-ad-motion: off by the user's choice, and paused while
  // no part of the app is on screen (a minimized window keeps drawing otherwise).
  const onScreen = useAppOnScreen();
  useEffect(() => {
    document.documentElement.dataset.reducedMotion = String(preferences.reducedMotion);
    document.documentElement.dataset.adMotion = preferences.reducedMotion || !onScreen ? "off" : "on";
  }, [preferences.reducedMotion, onScreen]);
  useEffect(() => applyAppFonts(preferences.headingFont, preferences.textFont), [preferences.headingFont, preferences.textFont]);
  // The theme name on the root lets the backdrop and the app icon follow it; colours come from NeoTheme.
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

  const openSettings = useCallback((tab: SettingsTab = "appearance") => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }, []);
  const value = useMemo<AppContextValue>(
    () => ({
      theme: preferences.theme,
      language: preferences.language,
      room,
      preferences,
      setTheme: theme => setPreferences(current => ({ ...current, theme })),
      setLanguage: language => setPreferences(current => ({ ...current, language })),
      openSettings,
      setRoom,
      updatePreferences: patch => setPreferences(current => ({ ...current, ...patch }))
    }),
    [preferences, room, openSettings]
  );
  const dialog = useMemo<SettingsDialogValue>(
    () => ({ settingsOpen, settingsTab, setSettingsOpen }),
    [settingsOpen, settingsTab]
  );

  return (
    <AppContext.Provider value={value}>
      <SettingsDialogContext.Provider value={dialog}>{children}</SettingsDialogContext.Provider>
    </AppContext.Provider>
  );
};

export const useSettingsDialog = (): SettingsDialogValue => {
  const value = useContext(SettingsDialogContext);
  if (!value) throw new Error("useSettingsDialog must be used inside AppProvider");
  return value;
};

export const useApp = (): AppContextValue => {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside AppProvider");
  return value;
};
