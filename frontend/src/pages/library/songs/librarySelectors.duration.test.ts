import { expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { queueSongImport } from '../../../components/api-service';
import { mapSong } from '../../../services/pythonMappers';
import type { SongDto, SongSearch } from '../../../contracts/models';
import { selectLibrarySongs } from './librarySelectors';
import api from './catalog-order-unicode.api-fixture.json';

const source = api.songs.find((song) => song.duration === null)!;
const filters: SongSearch = {
  query: '',
  status: 'all',
  language: 'all',
  artwork: 'all',
  duration: 'all',
  sort: 'duration',
  direction: 'asc',
};

it('filters by detected language for Auto and prefers a manually chosen language', () => {
  const automatic = mapSong({ ...source, language: 'Auto', detectedLanguage: 'Ukrainian' });
  const manual = { ...automatic, language: 'Russian' as const };
  expect(selectLibrarySongs([automatic, manual], { ...filters, language: 'Ukrainian' }))
    .toEqual([automatic]);
  expect(selectLibrarySongs([automatic, manual], { ...filters, language: 'Russian' }))
    .toEqual([manual]);
});

it.each(['short', 'medium', 'long'] as const)(
  'does not infer %s duration from the display fallback for an unknown-length file',
  (duration) => {
    const song = mapSong(source);
    expect(selectLibrarySongs([song], { ...filters, duration })).toEqual([]);
    expect(selectLibrarySongs([song], filters)).toEqual([song]);
  },
);

it('keeps a known zero duration in the short filter, as the API does', () => {
  const song = mapSong({ ...source, duration: 0 });
  expect(selectLibrarySongs([song], { ...filters, duration: 'short' })).toEqual(
    [song],
  );
});

it('preserves the numeric duration behavior of existing producers without metadata', () => {
  const { durationKnown: _durationKnown, ...song } = mapSong({
    ...source,
    duration: 0,
  });
  expect(selectLibrarySongs([song], { ...filters, duration: 'short' })).toEqual(
    [song],
  );
});

it('does not classify a queued import as short before its duration is known', () => {
  const client = new QueryClient();
  try {
    queueSongImport(client, '/music/Uninspected.opus');
    const songs = client.getQueryData<readonly SongDto[]>(['song-imports'])!;
    expect(
      selectLibrarySongs(songs, { ...filters, duration: 'short' }),
    ).toEqual([]);
    expect(selectLibrarySongs(songs, filters)).toEqual(songs);
  } finally {
    client.clear();
  }
});
