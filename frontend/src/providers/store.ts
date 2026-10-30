import type { KaraokeOpenMode } from "../application/karaoke/karaokeMachine";
import { radioStations } from "../app/radioStations";
import type { PendingDialog } from "./dialog";
import type { ServiceStatus } from "../app/serviceStatus";
import { setLocale } from "@neo-ui-kit/react";
import { makeAutoObservable, observable, observableRef } from "mobx";
import type { Language, SettingsTab, ThemeName, RoomStateDto, SongDto } from "../contracts/models";
import { loadPreferences, savePreferences, type Preferences } from "../shared/preferences/preferences";
import { appThemes } from './theme/variants';
import type { SocialInbox } from '../contracts/social';
import type { LibraryViewFilters } from '../pages/library/hero/search-field';

class Store {
  get currentTheme() { return appThemes[this.preferences.theme]; }
  preferences = loadPreferences();
  libraryDialogs = observable.object({
    addOpen: false,
    droppedPath: "",
    settingsSong: null as SongDto | null,
    recordingsSong: null as SongDto | null,
    analysisRecordId: null as string | null,
    processingOpen: false,
    focusSongId: undefined as string | undefined,
  }, { settingsSong: observableRef, recordingsSong: observableRef });
  // Remembers the page across navigation, without persisting it or subscribing renders to scroll changes.
  library = observable.object({
    query: "",
    filters: { status: "all", language: "all", duration: "all", artwork: "all" } as LibraryViewFilters,
    scrollTop: 0,
  }, { scrollTop: false });
  online = observable.object({ room: null as RoomStateDto | null }, { room: observableRef });
  application = {
    localProcessing: false,
    onScreen: true,
    get autoUpdate() { return store.preferences.autoUpdate; },
    services: {
      python: { kind: "starting" } as ServiceStatus,
      audio: { kind: "starting" } as ServiceStatus,
      pythonEpoch: 0, audioEpoch: 0,
      probe: async (): Promise<void> => {},
    },
  };

  playback = {
    launch: null as { songId: string; mode: KaraokeOpenMode } | null,
    returned: null as { performanceReturn?: boolean; analysisSongId?: string; analysisFor?: string } | null,
  };
  prepareKaraoke(songId: string, mode: KaraokeOpenMode) {
    this.playback.launch = { songId, mode };
    this.playback.returned = null;
  }
  returnFromKaraoke(value: typeof this.playback.returned) { this.playback.returned = value; }

  inbox: SocialInbox = { type: 'offline' };
  setInbox(inbox: SocialInbox) { this.inbox = inbox; }
  dialog: PendingDialog | null = null;
  settingsOpen = false;
  settingsTab: SettingsTab = "appearance";

  constructor() {
    setLocale(this.preferences.language);
    makeAutoObservable(this, { library: false, preferences: observableRef, inbox: observableRef, dialog: observableRef }, { autoBind: true });
  }

  get interface() {
    const { language, theme, headingFont, textFont, reducedMotion } = this.preferences;
    return { language, theme, headingFont, textFont, reducedMotion };
  }

  get profile() {
    return { displayName: this.preferences.displayName, photo: this.preferences.profilePhoto };
  }


  get integrations() {
    const { discordPresence, keyboardLighting } = this.preferences;
    return { discordPresence, keyboardLighting };
  }

  radio = {
    enabled: false,
    libraryActive: false,
    preparedKey: "",
    prepareRequest: 0,
    get volume() { return store.preferences.radioVolume; },
    get stationId() {
      const id = store.online.room?.radioStationId ?? store.preferences.radioStation;
      return radioStations.some(station => station.id === id) ? id : (radioStations[0]?.id ?? "");
    },
    get canControl() {
      const room = store.online.room;
      return !room || room.role === "host" || Boolean(room.collaborativeControl);
    },
  };

  get audio() {
    const p = this.preferences;
    return {
      configuration: p.audio, releaseAsioInBackground: p.releaseAsioInBackground,
      acousticLatencyMs: p.acousticLatencyMs,
      voice: { gain: p.voiceGain, monitoring: p.karaokeMonitoring,
        effects: { ...p.karaokeEffects, noiseSuppression: p.noiseSuppression } },
    };
  }

  updatePreferences(patch: Partial<Preferences>) {
    if (Object.entries(patch).every(([key, value]) =>
      Object.is(this.preferences[key as keyof Preferences], value))) return;
    if (patch.language) setLocale(patch.language);
    this.preferences = { ...this.preferences, ...patch };
    savePreferences(this.preferences);
  }

  setTheme(theme: ThemeName) {
    this.updatePreferences({ theme });
  }

  setLanguage(language: Language) {
    this.updatePreferences({ language });
  }

  openSettings(tab: SettingsTab = "appearance") {
    this.settingsTab = tab;
    this.settingsOpen = true;
  }

  setSettingsOpen(open: boolean) {
    this.settingsOpen = open;
  }
}

export const store = new Store();
