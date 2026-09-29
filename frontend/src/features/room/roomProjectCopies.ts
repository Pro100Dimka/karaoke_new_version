/**
 * Local copies of room projects fetched during this run of the app, by room song and revision.
 * A participant refreshes another singer's project once per run (its owner may have supplemented
 * the same revision), then reuses that copy in every room instead of downloading it again. The
 * copy may sit on a local id when the same song already existed here.
 */
const copies = new Map<string, string>();
const copyKey = (songId: string, revision: number) => `${songId}:${revision}`;

export const rememberRoomProjectCopy = (songId: string, revision: number, localSongId: string): void => {
  copies.set(copyKey(songId, revision), localSongId);
};

export const roomProjectCopy = (songId?: string, revision?: number): string | undefined =>
  songId && revision !== undefined ? copies.get(copyKey(songId, revision)) : undefined;
