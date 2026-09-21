export const formatTime = (seconds: number): string => {
  const safe = Math.max(0, Math.round(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
};

export const formatPreciseTime = (seconds: number): string => {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const remaining = (safe % 60).toFixed(2).padStart(5, "0");
  return `${minutes}:${remaining}`;
};

export const normalizeSearch = (value: string): string =>
  value.normalize("NFKC").toLocaleLowerCase();

export const formatBytes = (bytes: number): string => {
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
};
