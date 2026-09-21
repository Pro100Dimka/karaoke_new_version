import type { SongStatus } from "../../contracts/models";

/** Survives navigation to Karaoke/Editor within one app session; deliberately not persisted across restarts. */
export interface LibraryViewState {
  query: string;
  status: SongStatus | "all";
  scrollTop: number;
}

export const libraryViewState: LibraryViewState = { query: "", status: "all", scrollTop: 0 };
