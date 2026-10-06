import {
  isRecord,
  readJson,
  storageKey,
  writeJson,
} from "../../shared/storage/localStore";

/**
 * Local copies of room projects fetched from other singers, by room song and revision. A copy
 * may sit on a local id when the same song already existed here. Kept across restarts so a song
 * once transferred in a room is never downloaded again.
 */
const key = storageKey("roomProjectCopies");
let copies: Map<string, string> | undefined;
const copyKey = (songId: string, revision: number) => `${songId}:${revision}`;

const loaded = (): Map<string, string> => {
  if (copies) return copies;
  const stored = readJson(key);
  copies = new Map(
    isRecord(stored)
      ? Object.entries(stored).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        )
      : [],
  );
  return copies;
};

export const rememberRoomProjectCopy = (
  songId: string,
  revision: number,
  localSongId: string,
): void => {
  const current = loaded();
  current.set(copyKey(songId, revision), localSongId);
  writeJson(key, Object.fromEntries(current));
};

export const roomProjectCopy = (
  songId?: string,
  revision?: number,
): string | undefined =>
  songId && revision !== undefined
    ? loaded().get(copyKey(songId, revision))
    : undefined;
