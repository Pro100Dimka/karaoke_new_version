import type { AudioBackendName, Language, RequestedAudioConfiguration, ThemeName } from "../../contracts/models";
import { readJson, storageKey as localKey, writeJson } from "../storage/localStore";

export type LibrarySort = "recent" | "title" | "artist" | "played";

export interface Preferences {
  theme: ThemeName;
  language: Language;
  reducedMotion: boolean;
  librarySort: LibrarySort;
  karaokeShowNotes: boolean;
  karaokeShowLyrics: boolean;
  karaokeAutoHideConsole: boolean;
  musicGain: number;
  voiceGain: number;
  radioStation: string;
  radioVolume: number;
  displayName: string;
  audio: RequestedAudioConfiguration;
}

export const defaultAudioRequest = (): RequestedAudioConfiguration => ({
  backend: "WASAPI Shared",
  sampleRate: 48000,
  periodFrames: 256
});

const storageKey = localKey("preferences");

const systemReducedMotion = (): boolean =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export const defaultPreferences = (): Preferences => ({
  theme: "dark",
  language: "ru",
  reducedMotion: systemReducedMotion(),
  librarySort: "recent",
  karaokeShowNotes: true,
  karaokeShowLyrics: true,
  karaokeAutoHideConsole: true,
  musicGain: 0.82,
  voiceGain: 0.68,
  radioStation: "",
  radioVolume: 35,
  displayName: "",
  audio: defaultAudioRequest()
});

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.find(item => item === value) ?? fallback;

const gain = (value: unknown, fallback: number): number =>
  typeof value === "number" && value >= 0 && value <= 1 ? value : fallback;

const backends: readonly AudioBackendName[] = ["WASAPI Shared", "WASAPI Exclusive", "ASIO"];

const parseAudio = (raw: unknown): RequestedAudioConfiguration => {
  const base = defaultAudioRequest();
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const positive = (item: unknown, fallback: number) =>
    typeof item === "number" && Number.isFinite(item) && item > 0 ? item : fallback;
  const id = (item: unknown) => (typeof item === "string" && item ? item : undefined);
  return {
    backend: oneOf(value.backend, backends, base.backend),
    inputDeviceId: id(value.inputDeviceId),
    outputDeviceId: id(value.outputDeviceId),
    sampleRate: positive(value.sampleRate, base.sampleRate),
    periodFrames: positive(value.periodFrames, base.periodFrames)
  };
};

export const parsePreferences = (raw: unknown): Preferences => {
  const base = defaultPreferences();
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    theme: oneOf(value.theme, ["dark", "light", "green", "violet"], base.theme),
    language: oneOf(value.language, ["uk", "ru", "en"], base.language),
    reducedMotion: typeof value.reducedMotion === "boolean" ? value.reducedMotion : base.reducedMotion,
    librarySort: oneOf(value.librarySort, ["recent", "title", "artist", "played"], base.librarySort),
    karaokeShowNotes: typeof value.karaokeShowNotes === "boolean" ? value.karaokeShowNotes : base.karaokeShowNotes,
    karaokeShowLyrics: typeof value.karaokeShowLyrics === "boolean" ? value.karaokeShowLyrics : base.karaokeShowLyrics,
    karaokeAutoHideConsole:
      typeof value.karaokeAutoHideConsole === "boolean" ? value.karaokeAutoHideConsole : base.karaokeAutoHideConsole,
    musicGain: gain(value.musicGain, base.musicGain),
    voiceGain: gain(value.voiceGain, base.voiceGain),
    radioStation: typeof value.radioStation === "string" ? value.radioStation : base.radioStation,
    radioVolume:
      typeof value.radioVolume === "number" && value.radioVolume >= 0 && value.radioVolume <= 100
        ? value.radioVolume
        : base.radioVolume,
    displayName: typeof value.displayName === "string" ? value.displayName.slice(0, 40) : base.displayName,
    audio: parseAudio(value.audio)
  };
};

export const loadPreferences = (): Preferences => parsePreferences(readJson(storageKey));

export const savePreferences = (preferences: Preferences): void => writeJson(storageKey, preferences);
