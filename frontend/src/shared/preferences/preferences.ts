import type { AudioBackendName, Language, RequestedAudioConfiguration, ThemeName } from "../../contracts/models";
import { readJson, storageKey as localKey, writeJson } from "../storage/localStore";

export type LibrarySort = "recent" | "title" | "artist" | "played";

export interface KaraokeEffectPreferences {
  echo: number;
  reverb: number;
  delay: number;
}

/** Pixels relative to the karaoke stage; null means the piano roll still uses its default centred layout. */
export interface PianoRollLayout {
  left: number;
  top: number;
  width: number;
  height: number;
}

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
  referenceGain: number;
  melodyGain: number;
  karaokeSpeed: number;
  karaokeKeyShift: number;
  karaokeEffects: KaraokeEffectPreferences;
  pianoRollLayout: PianoRollLayout | null;
  /** 0..1, applied to the microphone in karaoke; the program settings' monitoring test always plays the clean voice. */
  noiseSuppression: number;
  radioStation: string;
  radioVolume: number;
  displayName: string;
  audio: RequestedAudioConfiguration;
}

export const defaultAudioRequest = (): RequestedAudioConfiguration => ({
  backend: "WASAPI Shared",
  // Zero means "ask the selected device". It is resolved by AudioService before the stream opens.
  sampleRate: 0,
  periodFrames: 0
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
  referenceGain: 0,
  melodyGain: 0,
  karaokeSpeed: 1,
  karaokeKeyShift: 0,
  karaokeEffects: { echo: 0, reverb: 0, delay: 0.24 },
  pianoRollLayout: null,
  noiseSuppression: 0,
  radioStation: "",
  radioVolume: 35,
  displayName: "",
  audio: defaultAudioRequest()
});

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.find(item => item === value) ?? fallback;

const gain = (value: unknown, fallback: number): number =>
  typeof value === "number" && value >= 0 && value <= 1 ? value : fallback;

const parseEffects = (raw: unknown, fallback: KaraokeEffectPreferences): KaraokeEffectPreferences => {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    echo: gain(value.echo, fallback.echo),
    reverb: gain(value.reverb, fallback.reverb),
    delay: gain(value.delay, fallback.delay)
  };
};

const finiteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const parsePianoRollLayout = (raw: unknown): PianoRollLayout | null => {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const { left, top, width, height } = value;
  return finiteNumber(left) && finiteNumber(top) && finiteNumber(width) && finiteNumber(height) && width > 0 && height > 0
    ? { left, top, width, height }
    : null;
};

const backends: readonly AudioBackendName[] = ["WASAPI Shared", "WASAPI Exclusive", "ASIO"];

const parseAudio = (raw: unknown): RequestedAudioConfiguration => {
  const base = defaultAudioRequest();
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const nonNegative = (item: unknown, fallback: number) =>
    typeof item === "number" && Number.isFinite(item) && item >= 0 ? item : fallback;
  const id = (item: unknown) => (typeof item === "string" && item ? item : undefined);
  return {
    backend: oneOf(value.backend, backends, base.backend),
    inputDeviceId: id(value.inputDeviceId),
    outputDeviceId: id(value.outputDeviceId),
    sampleRate: nonNegative(value.sampleRate, base.sampleRate),
    periodFrames: nonNegative(value.periodFrames, base.periodFrames)
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
    referenceGain: gain(value.referenceGain, base.referenceGain),
    melodyGain: gain(value.melodyGain, base.melodyGain),
    karaokeSpeed:
      typeof value.karaokeSpeed === "number" && value.karaokeSpeed >= 0.5 && value.karaokeSpeed <= 1.5
        ? value.karaokeSpeed
        : base.karaokeSpeed,
    karaokeKeyShift:
      typeof value.karaokeKeyShift === "number" && Number.isInteger(value.karaokeKeyShift) && value.karaokeKeyShift >= -12 && value.karaokeKeyShift <= 12
        ? value.karaokeKeyShift
        : base.karaokeKeyShift,
    karaokeEffects: parseEffects(value.karaokeEffects, base.karaokeEffects),
    pianoRollLayout: parsePianoRollLayout(value.pianoRollLayout),
    noiseSuppression: gain(value.noiseSuppression, base.noiseSuppression),
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
