import type { ProjectCompatibility } from "../../contracts/clients";
import type { SongDto } from "../../contracts/models";
import { pythonClient } from "../../services/pythonClient";
import { loadSongPreferences, type SongPreferences } from "../library/songPreferences";

export type KaraokeLoad =
  | { kind: "loading" }
  | { kind: "notFound" }
  | { kind: "notProcessed"; song: SongDto }
  | { kind: "projectIssue"; song: SongDto; compatibility: Exclude<ProjectCompatibility, "Current"> }
  | { kind: "ready"; song: SongDto };

export interface ResolvedKaraoke {
  load: KaraokeLoad;
  /** Present only when the song is ready to open. */
  prefs: SongPreferences | null;
}

/** Song identity, processing state and project compatibility must all pass before an audio session is prepared. */
export const resolveKaraokeLoad = async (songId: string): Promise<ResolvedKaraoke> => {
  let song: SongDto;
  try {
    song = await pythonClient.getSong(songId);
  } catch {
    return { load: { kind: "notFound" }, prefs: null };
  }
  if (song.status !== "ready") return { load: { kind: "notProcessed", song }, prefs: null };
  const compatibility = await pythonClient
    .projectCompatibility(song.id, song.activeRevision)
    .catch((): ProjectCompatibility => "Invalid");
  if (compatibility !== "Current") return { load: { kind: "projectIssue", song, compatibility }, prefs: null };
  return { load: { kind: "ready", song }, prefs: loadSongPreferences(song.id) };
};
