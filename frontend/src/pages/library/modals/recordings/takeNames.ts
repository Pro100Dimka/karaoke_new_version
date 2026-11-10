import { tr } from '@neo-ui-kit/react';
import type { RecordingDto } from '../../../../contracts/models';

const pad = (value: number): string => String(value).padStart(2, '0');

/** "Take N · YYYY-MM-DD HH:mm" in the interface language, numbered by recording order within the song. */
export const defaultTakeName = (number: number, createdAt: string): string => {
  const date = new Date(createdAt);
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return tr('takeDefaultName', { number, date: stamp });
};

export const numberTakes = (
  recordings: readonly RecordingDto[],
): ReadonlyMap<string, number> => {
  // Parse each date once: the comparator otherwise parses it O(n log n) times.
  const takes = recordings
    .filter((recording) => !recording.sourceRecordingId)
    .map((recording) => ({ recording, created: Date.parse(recording.createdAt) }));
  takes.sort(
    (a, b) =>
      a.created - b.created || a.recording.id.localeCompare(b.recording.id),
  );
  return new Map(takes.map(({ recording }, index) => [recording.id, index + 1]));
};
