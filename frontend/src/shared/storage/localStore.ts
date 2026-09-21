/**
 * The only module that touches browser storage. Every key is namespaced and versioned; unreadable or
 * unavailable storage degrades to "nothing stored" so persistence never breaks a feature.
 */
const namespace = "adVoice";

export const storageKey = (name: string, version = 1): string => `${namespace}.${name}.v${version}`;

export const readJson = (key: string): unknown => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
};

export const writeJson = (key: string, value: unknown): void => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Persisted values are conveniences; the caller keeps its in-memory value.
  }
};

export const removeKey = (key: string): void => {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing to remove when storage is unavailable.
  }
};

export const hasKeyWithPrefix = (prefix: string): boolean => {
  try {
    return Object.keys(window.localStorage).some(key => key.startsWith(prefix));
  } catch {
    return false;
  }
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
