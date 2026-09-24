import type { RecordingDto } from "../../contracts/models";

const pad = (value: number): string => String(value).padStart(2, "0");

/** "Take N · YYYY-MM-DD HH:mm", numbered by recording order within the song. */
export const defaultTakeName = (number: number, createdAt: string): string => {
  const date = new Date(createdAt);
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `Take ${number} · ${stamp}`;
};

export const numberTakes = (recordings: readonly RecordingDto[]): ReadonlyMap<string, number> =>
  new Map(
    [...recordings]
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))
      .map((recording, index) => [recording.id, index + 1] as const)
  );
