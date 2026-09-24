import type { SongDto, SongLanguage, SongStatus } from "../../contracts/models";
import type { LibrarySort, LibrarySortDirection } from "../../shared/preferences/preferences";
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

const compareText = (a: string, b: string): number => normalizeSearch(a).localeCompare(normalizeSearch(b));

/** Every sort ends in the same tie-breakers so equal primary values never reshuffle cards. */
const stableTail = (a: SongDto, b: SongDto): number =>
  compareText(a.title, b.title) || compareText(a.artist, b.artist) || a.id.localeCompare(b.id);

const primary = (sort: LibrarySort, played: LastPlayed) => (a: SongDto, b: SongDto): number => {
  if (sort === "artist") return compareText(a.artist, b.artist);
  if (sort === "title") return compareText(a.title, b.title);
  if (sort === "played") return (played[a.id] ?? 0) - (played[b.id] ?? 0);
  if (sort === "duration") return a.durationSeconds - b.durationSeconds;
  if (sort === "bpm") return (a.detectedBpm ?? -1) - (b.detectedBpm ?? -1);
  return Date.parse(a.createdAt) - Date.parse(b.createdAt) || 0;
};

const durationMatches = (seconds: number, filter: LibraryDurationFilter): boolean => {
  const ranges = {
    all: () => true,
    short: () => seconds < 180,
    medium: () => seconds >= 180 && seconds <= 300,
    long: () => seconds > 300,
  } satisfies Record<LibraryDurationFilter, () => boolean>;
  return ranges[filter]();
};

export const selectLibrarySongs = (
  songs: readonly SongDto[],
  filter: LibraryFilter,
  played: LastPlayed = {}
): readonly SongDto[] => {
  const query = normalizeSearch(filter.query.trim());
  const compare = primary(filter.sort, played);
  return songs
    .filter(song => {
      if (filter.status !== "all" && song.status !== filter.status) return false;
      if (filter.language !== "all" && song.language !== filter.language) return false;
      if (!durationMatches(song.durationSeconds, filter.duration)) return false;
      if (filter.artwork === "with" && !song.artworkUrl) return false;
      if (filter.artwork === "without" && song.artworkUrl) return false;
      if (!query) return true;
      return [song.title, song.artist, song.filename ?? ""].some(value => normalizeSearch(value).includes(query));
    })
    .sort((a, b) => (filter.direction === "asc" ? 1 : -1) * compare(a, b) || stableTail(a, b));
};
