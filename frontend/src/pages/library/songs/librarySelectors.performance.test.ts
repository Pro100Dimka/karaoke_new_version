import { afterEach, expect, it, vi } from 'vitest';
import type { SongDto, SongSearch } from '../../../contracts/models';
import { selectLibrarySongs } from './librarySelectors';

afterEach(() => vi.restoreAllMocks());

const filters: SongSearch = {
  query: '',
  status: 'all',
  language: 'all',
  artwork: 'all',
  duration: 'all',
  sort: 'title',
  direction: 'asc',
};

const song = (id: number, title: string): SongDto => ({
  id: String(id),
  title,
  artist: title,
  language: 'English',
  status: 'ready',
  durationSeconds: 180,
  createdAt: '2026-01-01',
  coverState: 'Fallback',
  activeRevision: 1,
  projectFormatVersion: 1,
});

it.each(['title', 'artist'] as const)(
  'normalizes each %s once when sorting a full library',
  (sort) => {
    const songs = Array.from({ length: 2000 }, (_, index) =>
      song(index, `Straße ${String((index * 997) % 2000).padStart(4, '0')}`),
    );
    const normalize = vi.spyOn(String.prototype, 'normalize');
    const sorted = selectLibrarySongs(songs, { ...filters, sort });
    expect(sorted[0]?.title).toBe('Straße 0000');
    expect(sorted.at(-1)?.title).toBe('Straße 1999');
    expect(normalize.mock.calls.length).toBeLessThanOrEqual(songs.length + 1);
  },
);

it('retains Unicode code-point order, stable ID ties and refreshed metadata', () => {
  const songs = [
    song(4, '\u{10000}'),
    song(3, '\ue000'),
    song(2, 'STRASSE'),
    song(1, ' Straße '),
  ];
  expect(selectLibrarySongs(songs, filters).map(({ id }) => id)).toEqual([
    '1',
    '2',
    '3',
    '4',
  ]);
  expect(
    selectLibrarySongs(songs, { ...filters, direction: 'desc' }).map(
      ({ id }) => id,
    ),
  ).toEqual(['4', '3', '1', '2']);
  songs[3]!.title = 'ZZZ';
  expect(selectLibrarySongs(songs, filters).map(({ id }) => id)).toEqual([
    '2',
    '1',
    '3',
    '4',
  ]);
});
