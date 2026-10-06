import type { RecordingDto } from "../../contracts/models";
import type { ITranslate } from "../../i18n/useText";

const pad = (value: number): string => String(value).padStart(2, "0");

/** "Take N · YYYY-MM-DD HH:mm" in the interface language, numbered by recording order within the song. */
export const defaultTakeName = (t: ITranslate, number: number, createdAt: string): string => {
  const date = new Date(createdAt);
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return t("takeDefaultName", { number, date: stamp });
};

export const numberTakes = (
  recordings: readonly RecordingDto[],
): ReadonlyMap<string, number> =>
  new Map(
    // A Studio Master is a version of a take, not a take of its own: it does not use a number.
    recordings
      .filter((recording) => !recording.sourceRecordingId)
      .sort(
        (a, b) =>
          Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
          a.id.localeCompare(b.id),
      )
      .map((recording, index) => [recording.id, index + 1] as const),
  );
