import { reportOperationFailure, clearOperationFailure } from '../errors';
/**
 * The only module that touches browser storage. Every key is namespaced and versioned; unreadable or
 * unavailable storage degrades to "nothing stored" so persistence never breaks a feature.
 */
const namespace = 'adVoice';
const storageAreas = {
  local: 'localStorage',
  session: 'sessionStorage',
} as const;
type StorageArea = keyof typeof storageAreas;

export const storageKey = (name: string, version = 1): string =>
  `${namespace}.${name}.v${version}`;

export const readJson = (key: string, area: StorageArea = 'local'): unknown => {
  try {
    const raw = window[storageAreas[area]].getItem(key);
    const value: unknown = raw === null ? null : JSON.parse(raw);
    clearOperationFailure('errors.storageRead');
    return value;
  } catch (error) {
    reportOperationFailure('errors.storageRead', error);
    return null;
  }
};

export const writeJson = (
  key: string,
  value: unknown,
  area: StorageArea = 'local',
): void => {
  try {
    window[storageAreas[area]].setItem(key, JSON.stringify(value));
    clearOperationFailure('errors.storageWrite');
  } catch (error) {
    reportOperationFailure('errors.storageWrite', error);
    // Persisted values are conveniences; the caller keeps its in-memory value.
  }
};

/** A plain string value, for keys written before values were stored as JSON. */
export const readText = (
  key: string,
  area: StorageArea = 'local',
): string | null => {
  try {
    const value = window[storageAreas[area]].getItem(key);
    clearOperationFailure('errors.storageRead');
    return value;
  } catch (error) {
    reportOperationFailure('errors.storageRead', error);
    return null;
  }
};

export const writeText = (
  key: string,
  value: string,
  area: StorageArea = 'local',
): void => {
  try {
    window[storageAreas[area]].setItem(key, value);
    clearOperationFailure('errors.storageWrite');
  } catch (error) {
    reportOperationFailure('errors.storageWrite', error);
    // Persisted values are conveniences; the caller keeps its in-memory value.
  }
};

export const removeKey = (key: string, area: StorageArea = 'local'): void => {
  try {
    window[storageAreas[area]].removeItem(key);
    clearOperationFailure('errors.storageWrite');
  } catch (error) {
    reportOperationFailure('errors.storageWrite', error);
    // Nothing to remove when storage is unavailable.
  }
};

/** Forgets every stored convenience (tests start each case from a clean slate with it). */
export const clearStorage = (area: StorageArea = 'local'): void => {
  try {
    window[storageAreas[area]].clear();
    clearOperationFailure('errors.storageWrite');
  } catch (error) {
    reportOperationFailure('errors.storageWrite', error);
    // Nothing to clear when storage is unavailable.
  }
};

export const hasKeyWithPrefix = (prefix: string): boolean => {
  try {
    return Object.keys(window.localStorage).some((key) =>
      key.startsWith(prefix),
    );
  } catch (error) {
    reportOperationFailure('errors.storageRead', error);
    return false;
  }
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
