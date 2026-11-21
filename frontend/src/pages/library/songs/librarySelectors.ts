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

/** Match the backend's normalized Unicode order independently of the UI locale. */
const compareText = (
  left: readonly string[],
  right: readonly string[],
): number => {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const difference =
      left[index]!.codePointAt(0)! - right[index]!.codePointAt(0)!;
    if (difference) return difference;
  }
  return left.length - right.length;
};

/** Search cursors use ascending song IDs to break ties, even for descending primary sorts. */
const stableTail = (a: SongDto, b: SongDto): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

type CompareSongs = (a: SongDto, b: SongDto, played: LastPlayed) => number;
const compareByText = (field: 'title' | 'artist'): CompareSongs => {
  // A sort compares each song many times; fold its Unicode text only once.
  // Keep this cache within one selection so edited metadata is never stale.
  const keys = new Map<SongDto, readonly string[]>();
  const key = (song: SongDto) => {
    let value = keys.get(song);
    if (!value) {
      value = Array.from(normalizeSearch(song[field]).trim());
      keys.set(song, value);
    }
    return value;
  };
  return (a, b) => compareText(key(a), key(b));
};
const primary: Record<
  Exclude<LibrarySort, 'recent' | 'title' | 'artist'>,
  CompareSongs
> = {
  played: (a, b, played) => (played[a.id] ?? 0) - (played[b.id] ?? 0),
  duration: (a, b) => a.durationSeconds - b.durationSeconds,
  bpm: (a, b) => (a.detectedBpm ?? 0) - (b.detectedBpm ?? 0),
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
  medium: (seconds) => seconds >= 180 && seconds < 300,
  long: (seconds) => seconds >= 300,
};

export const selectLibrarySongs = (
  songs: readonly SongDto[],
  filter: LibraryFilter,
  played: LastPlayed = {},
): readonly SongDto[] => {
  const query = normalizeSearch(filter.query.trim());
  const { sort, direction } = filter;
  const compare =
    sort === 'title' || sort === 'artist'
      ? compareByText(sort)
      : sort === 'recent'
        ? undefined
        : primary[sort];
  return songs
    .filter((song) => {
      if (filter.status !== 'all' && song.status !== filter.status)
        return false;
      const language =
        song.language === 'Auto' ? song.detectedLanguage ?? song.language : song.language;
      if (filter.language !== 'all' && language !== filter.language)
        return false;
      if (filter.duration !== 'all' && song.durationKnown === false)
        return false;
      if (!durationMatches[filter.duration](song.durationSeconds)) return false;
      if (filter.artwork === 'with' && !song.artworkUrl) return false;
      if (filter.artwork === 'without' && song.artworkUrl) return false;
      if (!query) return true;
      return [song.title, song.artist, song.filename ?? ''].some((value) =>
        normalizeSearch(value).includes(query),
      );
    })
    .sort((a, b) =>
      sort === 'recent'
        ? compareAddedSongs(a, b, direction)
        : (direction === 'asc' ? 1 : -1) * compare!(a, b, played) ||
          stableTail(a, b),
    );
};
