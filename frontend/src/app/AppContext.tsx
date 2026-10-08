import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { RoomSessionController } from "../application/room/RoomSessionController";
import { RoomPlaybackCoordinator } from "../application/room/RoomPlaybackCoordinator";
import { RoomLibraryCoordinator } from "../application/room/RoomLibraryCoordinator";
import { RoomMembershipCoordinator } from "../application/room/RoomMembershipCoordinator";
import { RoomRuntimeCoordinator } from "../application/room/RoomRuntimeCoordinator";
import type { RoomVoiceCoordinator } from "../application/room/RoomVoiceCoordinator";
import { applyAppFonts } from "../shared/preferences/appFonts";
import type {
  Language,
  RoomStateDto,
  SettingsTab,
  ThemeName,
} from "../contracts/models";
import { audioClient } from "../services/audioClient";
import { desktopClient } from "../services/desktopClient";
import { pythonClient } from "../services/pythonClient";
import { roomClient } from "../services/roomClient";
import { participantId } from "../services/roomMappers";
import { rememberRoomProjectCopy, roomProjectCopy } from "../services/roomProjectCopies";
import { readText, removeKey, storageKey, writeText } from "../shared/storage/localStore";
import { useAppOnScreen } from "./useAppOnScreen";
import {
  loadPreferences,
  savePreferences,
  type Preferences,
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
  updatePreferences(patch: Partial<Preferences>): void;
}

/** Whether the settings dialog is open and on which tab: read only by the dialog itself. */
interface SettingsDialogValue {
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  setSettingsOpen(value: boolean): void;
}

type AppSlices = {
  language: Pick<AppContextValue, "language">;
  theme: Pick<AppContextValue, "theme">;
  preferences: Pick<AppContextValue, "preferences" | "updatePreferences">;
  room: Pick<AppContextValue, "room">;
  actions: Pick<AppContextValue, "setTheme" | "setLanguage" | "openSettings" | "updatePreferences">;
};
const AppContext = createContext<AppContextValue | null>(null);
const LanguageContext = createContext<AppSlices["language"] | null>(null);
const ThemeContext = createContext<AppSlices["theme"] | null>(null);
const PreferencesContext = createContext<AppSlices["preferences"] | null>(null);
const RoomContext = createContext<AppSlices["room"] | null>(null);
const ActionsContext = createContext<AppSlices["actions"] | null>(null);
const RoomSessionContext = createContext<RoomSessionController | null>(null);
const RoomRuntimeContext = createContext<RoomRuntimeCoordinator | null>(null);
const contexts = { all: AppContext, language: LanguageContext, theme: ThemeContext,
  preferences: PreferencesContext, room: RoomContext, actions: ActionsContext };
// Kept apart from the app context: opening or closing the dialog must not redraw every screen that reads the app
// context (the library grid, karaoke, the room panel...), only the dialog.
const SettingsDialogContext = createContext<SettingsDialogValue | null>(null);

export const AppProvider = ({ children }: { children: ReactNode }) => {
  const [preferences, setPreferences] = useState<Preferences>(loadPreferences);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("appearance");
  const [roomSession] = useState(() => {
    const key = storageKey("roomSession");
    return new RoomSessionController(roomClient, audioClient, participantId, {
      load: () => readText(key),
      save: (code) => writeText(key, code),
      clear: () => removeKey(key),
    });
  });
  const [roomRuntime] = useState(() => new RoomRuntimeCoordinator(roomSession, {
    room: roomClient, audio: audioClient, python: pythonClient, desktop: desktopClient,
    copies: { get: roomProjectCopy, remember: rememberRoomProjectCopy }, participantId,
  }));
  useEffect(() => () => roomRuntime.dispose(), [roomRuntime]);
  const room = useSyncExternalStore(roomSession.subscribe, roomSession.getRoom, roomSession.getRoom);
  const asioSuspended = useRef(false);
  const asioTransition = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => savePreferences(preferences), [preferences]);
  // Keep the open dialog's motion alive; AppShell pauses only the obscured route.
  const onScreen = useAppOnScreen();
  useEffect(() => {
    document.documentElement.dataset.reducedMotion = String(
      preferences.reducedMotion,
    );
    document.documentElement.dataset.adMotion =
      preferences.reducedMotion || !onScreen ? "off" : "on";
  }, [preferences.reducedMotion, onScreen]);
  useEffect(
    () => applyAppFonts(preferences.headingFont, preferences.textFont),
    [preferences.headingFont, preferences.textFont],
  );
  // The theme name on the root lets the backdrop and the app icon follow it; colours come from NeoTheme.
  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme;
    void desktopClient.setAppIcon(preferences.theme);
  }, [preferences.theme]);
  useEffect(() => {
    const enabled =
      preferences.releaseAsioInBackground &&
      preferences.audio.backend === "ASIO" &&
      room === null;
    const setSuspended = (suspended: boolean) => {
      if (asioSuspended.current === suspended) return;
      asioSuspended.current = suspended;
      asioTransition.current = asioTransition.current
        .then(() =>
          suspended
            ? audioClient.suspendSession()
            : audioClient.resumeSession(),
        )
        .catch(() => {
          asioSuspended.current = false;
        });
    };
    const suspend = () => {
      if (enabled && !settingsOpen) setSuspended(true);
    };
    const resume = () => setSuspended(false);
    const onWindowState = (state: WindowState) => {
      if (state.minimized && enabled) setSuspended(true);
      else if (!state.minimized) resume();
    };
    window.addEventListener("blur", suspend);
    window.addEventListener("focus", resume);
    const unsubscribeWindowState =
      desktopClient.onWindowState?.(onWindowState) ?? (() => undefined);
    if (!enabled) resume();
    return () => {
      window.removeEventListener("blur", suspend);
      window.removeEventListener("focus", resume);
      unsubscribeWindowState();
    };
  }, [
    preferences.audio.backend,
    preferences.releaseAsioInBackground,
    room,
    settingsOpen,
  ]);

  const openSettings = useCallback((tab: SettingsTab = "appearance") => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }, []);
  const setTheme = useCallback((theme: ThemeName) =>
    setPreferences(current => current.theme === theme ? current : ({ ...current, theme })), []);
  const setLanguage = useCallback((language: Language) =>
    setPreferences(current => current.language === language ? current : ({ ...current, language })), []);
  const updatePreferences = useCallback((patch: Partial<Preferences>) =>
    setPreferences(current => Object.entries(patch).every(
      ([key, value]) => Object.is(current[key as keyof Preferences], value),
    ) ? current : ({ ...current, ...patch })), []);
  const value = useMemo<AppContextValue>(
    () => ({
      theme: preferences.theme,
      language: preferences.language,
      room,
      preferences,
      setTheme,
      setLanguage,
      openSettings,
      updatePreferences,
    }),
    [preferences, room, openSettings, setTheme, setLanguage, updatePreferences],
  );
  const languageValue = useMemo(() => ({ language: preferences.language }), [preferences.language]);
  const themeValue = useMemo(() => ({ theme: preferences.theme }), [preferences.theme]);
  const preferencesValue = useMemo(() => ({ preferences, updatePreferences }), [preferences, updatePreferences]);
  const roomValue = useMemo(() => ({ room }), [room]);
  const actionsValue = useMemo(() => ({ setTheme, setLanguage, openSettings, updatePreferences }),
    [setTheme, setLanguage, openSettings, updatePreferences]);
  const dialog = useMemo<SettingsDialogValue>(
    () => ({ settingsOpen, settingsTab, setSettingsOpen }),
    [settingsOpen, settingsTab],
  );

  return (
    <AppContext.Provider value={value}>
      <RoomSessionContext.Provider value={roomSession}>
        <RoomRuntimeContext.Provider value={roomRuntime}>
          <LanguageContext.Provider value={languageValue}>
          <ThemeContext.Provider value={themeValue}>
            <PreferencesContext.Provider value={preferencesValue}>
              <RoomContext.Provider value={roomValue}>
                <ActionsContext.Provider value={actionsValue}>
                  <SettingsDialogContext.Provider value={dialog}>
                    {children}
                  </SettingsDialogContext.Provider>
                </ActionsContext.Provider>
              </RoomContext.Provider>
            </PreferencesContext.Provider>
          </ThemeContext.Provider>
          </LanguageContext.Provider>
        </RoomRuntimeContext.Provider>
      </RoomSessionContext.Provider>
    </AppContext.Provider>
  );
};

export const useSettingsDialog = (): SettingsDialogValue => {
  const value = useContext(SettingsDialogContext);
  if (!value)
    throw new Error("useSettingsDialog must be used inside AppProvider");
  return value;
};

export const useRoomSession = (): RoomSessionController => {
  const value = useContext(RoomSessionContext);
  if (!value) throw new Error("useRoomSession must be used inside AppProvider");
  return value;
};

export const useRoomPlayback = (): RoomPlaybackCoordinator | null => {
  const session = useRoomSession();
  const scope = useSyncExternalStore(session.subscribe, session.getScope, session.getScope);
  return useMemo(() => scope ? new RoomPlaybackCoordinator(scope, roomClient) : null, [scope]);
};

export const useRoomLibraryCommands = (): RoomLibraryCoordinator | null => {
  const session = useRoomSession();
  const scope = useSyncExternalStore(session.subscribe, session.getScope, session.getScope);
  return useMemo(() => scope ? new RoomLibraryCoordinator(scope, roomClient) : null, [scope]);
};

export const useRoomMembership = (): RoomMembershipCoordinator | null => {
  const session = useRoomSession();
  const scope = useSyncExternalStore(session.subscribe, session.getScope, session.getScope);
  return useMemo(() => scope
    ? new RoomMembershipCoordinator(scope, roomClient, audioClient, desktopClient) : null, [scope]);
};

export const useRoomRuntime = (): RoomRuntimeCoordinator => {
  const value = useContext(RoomRuntimeContext);
  if (!value) throw new Error("useRoomRuntime must be used inside AppProvider");
  return value;
};

export const useRoomVoice = (): RoomVoiceCoordinator | null => {
  const runtime = useRoomRuntime();
  return useSyncExternalStore(runtime.subscribe, runtime.getVoice, runtime.getVoice);
};

// Select one stable context per consumer; unrelated room and preference updates stay local.
export function useApp(): AppContextValue;
export function useApp<K extends keyof AppSlices>(scope: K): AppSlices[K];
export function useApp(scope: keyof AppSlices | "all" = "all") {
  const context = contexts[scope] as import("react").Context<AppContextValue | null>;
  const value = useContext(context);
  if (!value) throw new Error("useApp must be used inside AppProvider");
  return value;
}
