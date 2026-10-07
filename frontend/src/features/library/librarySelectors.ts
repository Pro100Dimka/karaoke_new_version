import type { SongDto, SongLanguage, SongStatus } from "../../contracts/models";
import type {
  LibrarySort,
  LibrarySortDirection,
} from "../../shared/preferences/preferences";
import { normalizeSearch } from "../../shared/utils/format";

export type { LibrarySort };
export type LibraryLanguageFilter = SongLanguage | "all";
export type LibraryDurationFilter = "all" | "short" | "medium" | "long";
export type LibraryArtworkFilter = "all" | "with" | "without";
export interface LibraryFilter {
  query: string;
  status: SongStatus | "all";
  language: LibraryLanguageFilter;
  duration: LibraryDurationFilter;
  artwork: LibraryArtworkFilter;
  sort: LibrarySort;
  direction: LibrarySortDirection;
}

export type LastPlayed = Readonly<Record<string, number>>;

const compareText = (a: string, b: string): number =>
  normalizeSearch(a).localeCompare(normalizeSearch(b));

/** Every sort ends in the same tie-breakers so equal primary values never reshuffle cards. */
const stableTail = (a: SongDto, b: SongDto): number =>
  compareText(a.title, b.title) ||
  compareText(a.artist, b.artist) ||
  a.id.localeCompare(b.id);

type CompareSongs = (a: SongDto, b: SongDto, played: LastPlayed) => number;
const primary: Record<LibrarySort, CompareSongs> = {
  recent: (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || 0,
  title: (a, b) => compareText(a.title, b.title),
  artist: (a, b) => compareText(a.artist, b.artist),
  played: (a, b, played) => (played[a.id] ?? 0) - (played[b.id] ?? 0),
  duration: (a, b) => a.durationSeconds - b.durationSeconds,
  bpm: (a, b) => (a.detectedBpm ?? -1) - (b.detectedBpm ?? -1),
};

const durationMatches: Record<LibraryDurationFilter, (seconds: number) => boolean> = {
  all: () => true,
  short: (seconds) => seconds < 180,
  medium: (seconds) => seconds >= 180 && seconds <= 300,
  long: (seconds) => seconds > 300,
};

export const selectLibrarySongs = (
  songs: readonly SongDto[],
  filter: LibraryFilter,
  played: LastPlayed = {},
): readonly SongDto[] => {
  const query = normalizeSearch(filter.query.trim());
  const compare = primary[filter.sort];
  return songs
    .filter((song) => {
      if (filter.status !== "all" && song.status !== filter.status)
        return false;
      if (filter.language !== "all" && song.language !== filter.language)
        return false;
      if (!durationMatches[filter.duration](song.durationSeconds)) return false;
      if (filter.artwork === "with" && !song.artworkUrl) return false;
      if (filter.artwork === "without" && song.artworkUrl) return false;
      if (!query) return true;
      return [song.title, song.artist, song.filename ?? ""].some((value) =>
        normalizeSearch(value).includes(query),
      );
    })
    .sort(
      (a, b) =>
        (filter.direction === "asc" ? 1 : -1) * compare(a, b, played) ||
        stableTail(a, b),
    );
};
