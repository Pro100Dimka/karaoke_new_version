import searchCasefold from './searchCasefold.generated.json';

// Complete default casefold from scripts/generate-search-casefold.py.
const casefoldMappings: Readonly<Record<string, string>> =
  searchCasefold.mappings;

export const formatTime = (seconds: number): string => {
  const safe = Math.max(0, Math.round(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
};

export const formatPreciseTime = (seconds: number): string => {
  const safe = Math.max(0, Math.round(seconds * 100));
  const minutes = Math.floor(safe / 6000);
  const remaining = ((safe % 6000) / 100).toFixed(2).padStart(5, '0');
  return `${minutes}:${remaining}`;
};

export const normalizeSearch = (value: string): string =>
  Array.from(
    value.normalize('NFKC'),
    (char) => casefoldMappings[char.codePointAt(0)!] ?? char,
  ).join('');

export const formatBytes = (bytes: number): string => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
};
