import type {
  SongDto,
  SongLanguage,
  SongSearch,
} from '../../../contracts/models';
import type {
  LibrarySort,
  LibrarySortDirection,
} from '../../../shared/preferences/preferences';
import { normalizeSearch } from '../../../shared/utils/format';

export type { LibrarySort };
export type LibraryLanguageFilter = SongLanguage | 'all';
export type LibraryDurationFilter = 'all' | 'short' | 'medium' | 'long';
export type LibraryArtworkFilter = 'all' | 'with' | 'without';
type LibraryFilter = SongSearch;

export type LastPlayed = Readonly<Record<string, number>>;

const compareText = (a: string, b: string): number =>
  normalizeSearch(a).localeCompare(normalizeSearch(b));

/** Every sort ends in the same tie-breakers so equal primary values never reshuffle cards. */
const stableTail = (a: SongDto, b: SongDto): number =>
  compareText(a.title, b.title) ||
  compareText(a.artist, b.artist) ||
  a.id.localeCompare(b.id);

type CompareSongs = (a: SongDto, b: SongDto, played: LastPlayed) => number;
const primary: Record<Exclude<LibrarySort, 'recent'>, CompareSongs> = {
  title: (a, b) => compareText(a.title, b.title),
  artist: (a, b) => compareText(a.artist, b.artist),
  played: (a, b, played) => (played[a.id] ?? 0) - (played[b.id] ?? 0),
  duration: (a, b) => a.durationSeconds - b.durationSeconds,
  bpm: (a, b) => (a.detectedBpm ?? -1) - (b.detectedBpm ?? -1),
};

/** Pending imports are the next additions. Their order comes from the file selection. */
export const compareAddedSongs = (
  a: SongDto,
  b: SongDto,
  direction: LibrarySortDirection,
): number => {
  const aPending = a.status === 'importing';
  const bPending = b.status === 'importing';
  if (aPending && bPending) return 0;
  const order = direction === 'asc' ? 1 : -1;
  const byDate =
    Number(aPending) - Number(bPending) ||
    Date.parse(a.createdAt) - Date.parse(b.createdAt);
  return order * byDate || a.id.localeCompare(b.id);
};

const durationMatches: Record<
  LibraryDurationFilter,
  (seconds: number) => boolean
> = {
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
  const { sort, direction } = filter;
  return songs
    .filter((song) => {
      if (filter.status !== 'all' && song.status !== filter.status)
        return false;
      if (filter.language !== 'all' && song.language !== filter.language)
        return false;
      if (!durationMatches[filter.duration](song.durationSeconds)) return false;
      if (filter.artwork === 'with' && !song.artworkUrl) return false;
      if (filter.artwork === 'without' && song.artworkUrl) return false;
      if (!query) return true;
      return [song.title, song.artist, song.filename ?? ''].some((value) =>
        normalizeSearch(value).includes(query),
      );
    })
    .sort(
      (a, b) =>
        sort === 'recent'
          ? compareAddedSongs(a, b, direction)
          : (direction === 'asc' ? 1 : -1) * primary[sort](a, b, played) ||
            stableTail(a, b),
    );
};
