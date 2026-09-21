import type { SongDto, SongStatus } from "../../contracts/models";
import type { LibrarySort } from "../../shared/preferences/preferences";
import { normalizeSearch } from "../../shared/utils/format";

export type { LibrarySort };
export interface LibraryFilter {
  query: string;
  status: SongStatus | "all";
  sort: LibrarySort;
}

export type LastPlayed = Readonly<Record<string, number>>;

const compareText = (a: string, b: string): number => normalizeSearch(a).localeCompare(normalizeSearch(b));

/** Every sort ends in the same tie-breakers so equal primary values never reshuffle cards. */
const stableTail = (a: SongDto, b: SongDto): number =>
  compareText(a.title, b.title) || compareText(a.artist, b.artist) || a.id.localeCompare(b.id);

const primary = (sort: LibrarySort, played: LastPlayed) => (a: SongDto, b: SongDto): number => {
  if (sort === "artist") return compareText(a.artist, b.artist);
  if (sort === "title") return compareText(a.title, b.title);
  if (sort === "played") return (played[b.id] ?? 0) - (played[a.id] ?? 0);
  return Date.parse(b.createdAt) - Date.parse(a.createdAt) || 0;
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
      if (!query) return true;
      return [song.title, song.artist, song.filename ?? ""].some(value => normalizeSearch(value).includes(query));
    })
    .sort((a, b) => compare(a, b) || stableTail(a, b));
};
