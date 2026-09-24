import type { SongStatus } from "../../contracts/models";
import type { LibraryArtworkFilter, LibraryDurationFilter, LibraryLanguageFilter } from "./librarySelectors";

/** Survives navigation to Karaoke/Editor within one app session; deliberately not persisted across restarts. */
export interface LibraryViewState {
  query: string;
  status: SongStatus | "all";
  language: LibraryLanguageFilter;
  duration: LibraryDurationFilter;
  artwork: LibraryArtworkFilter;
  scrollTop: number;
}

export const libraryViewState: LibraryViewState = {
  query: "",
  status: "all",
  language: "all",
  duration: "all",
  artwork: "all",
  scrollTop: 0,
};
