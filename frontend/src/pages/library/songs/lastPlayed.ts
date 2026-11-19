import {
  isRecord,
  readJson,
  storageKey,
  writeJson,
} from '../../../shared/storage/localStore';
import type { LastPlayed } from './librarySelectors';

const key = storageKey('lastPlayed');
const listeners = new Set<(played: LastPlayed) => void>();

export const loadLastPlayed = (): LastPlayed => {
  const raw = readJson(key);
  if (!isRecord(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number',
    ),
  );
};

export const onLastPlayedChange = (listener: (played: LastPlayed) => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const markPlayed = (songId: string, now = Date.now()): void => {
  const played = { ...loadLastPlayed(), [songId]: now };
  writeJson(key, played);
  listeners.forEach((listener) => listener(played));
};
