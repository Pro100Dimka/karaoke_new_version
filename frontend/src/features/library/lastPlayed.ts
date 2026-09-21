import { isRecord, readJson, storageKey, writeJson } from "../../shared/storage/localStore";
import type { LastPlayed } from "./librarySelectors";

const key = storageKey("lastPlayed");

export const loadLastPlayed = (): LastPlayed => {
  const raw = readJson(key);
  if (!isRecord(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
};

export const markPlayed = (songId: string, now = Date.now()): void =>
  writeJson(key, { ...loadLastPlayed(), [songId]: now });
