import { isRecord, readJson, storageKey, writeJson } from "../../shared/storage/localStore";

export type VocalRange = "auto" | "octave" | "twoOctaves";

/** Per-song presentation defaults that the backend does not own; applied without reprocessing. */
export interface SongPreferences {
  videoUrl: string;
  defaultKey: number;
  defaultSpeed: number;
  vocalRange: VocalRange;
}

export const defaultSongPreferences: SongPreferences = { videoUrl: "", defaultKey: 0, defaultSpeed: 1, vocalRange: "auto" };
export const practiceSpeeds = [0.5, 0.65, 0.75, 0.85, 1] as const;

const key = storageKey("songPreferences");

const readAll = (): Record<string, Partial<SongPreferences>> => {
  const raw = readJson(key);
  return isRecord(raw) ? (raw as Record<string, Partial<SongPreferences>>) : {};
};

export const loadSongPreferences = (songId: string): SongPreferences => {
  const stored = readAll()[songId] ?? {};
  return {
    videoUrl: typeof stored.videoUrl === "string" ? stored.videoUrl : defaultSongPreferences.videoUrl,
    defaultKey:
      typeof stored.defaultKey === "number" && Math.abs(stored.defaultKey) <= 12
        ? Math.round(stored.defaultKey)
        : defaultSongPreferences.defaultKey,
    defaultSpeed: practiceSpeeds.find(speed => speed === stored.defaultSpeed) ?? defaultSongPreferences.defaultSpeed,
    vocalRange:
      stored.vocalRange === "octave" || stored.vocalRange === "twoOctaves" ? stored.vocalRange : "auto"
  };
};

export const saveSongPreferences = (songId: string, value: SongPreferences): void =>
  writeJson(key, { ...readAll(), [songId]: value });
