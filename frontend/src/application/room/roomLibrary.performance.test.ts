import { expect, it } from 'vitest';
import type { RoomSongDto, SongDto } from '../../contracts/models';
import { mergeRoomLibrary } from './roomLibrary';

const song = (
  id: string,
  sourceHash: string,
  projectHash = sourceHash,
): SongDto => ({
  id,
  sourceHash,
  projectHash,
  title: id,
  artist: '',
  language: 'Auto',
  status: 'ready',
  durationSeconds: 120,
  createdAt: '',
  coverState: 'Fallback',
  activeRevision: 1,
  projectFormatVersion: 1,
});
const shared = (
  id: string,
  sourceHash: string,
  projectHash = sourceHash,
): RoomSongDto => ({
  songId: id,
  sourceHash,
  projectHash,
  title: id,
  artist: '',
  durationSeconds: 120,
  revision: 2,
  ownerParticipantId: 'friend',
});

it('merges large room catalogs without a full local scan for each remote song', () => {
  let reads = 0;
  const local = Array.from({ length: 500 }, (_, index) => ({
    ...song(`local-${index}`, `l${index}`),
    get sourceHash() {
      reads++;
      return `l${index}`;
    },
  }));
  const remote = Array.from({ length: 500 }, (_, index) =>
    shared(`remote-${index}`, `r${index}`),
  );
  const merged = mergeRoomLibrary(local, remote, 'self');
  expect(merged).toHaveLength(1000);
  expect(reads).toBeLessThanOrEqual(local.length * 3);
});

it('keeps the earliest surviving source-or-project match after replacing a failed local song', () => {
  const local = [
    { ...song('a', 'x', 'old'), status: 'failed' as const },
    song('b', 'b-source', 'y'),
  ];
  expect(
    mergeRoomLibrary(
      local,
      [shared('c', 'x', 'y'), shared('d', 'x', 'y')],
      'self',
    ).map(({ id }) => id),
  ).toEqual(['b', 'c']);
});

it('prioritizes exact IDs and removes obsolete hash matches after replacement', () => {
  const local = [
    song('a', 'x'),
    { ...song('b', 'old'), status: 'failed' as const },
  ];
  const result = mergeRoomLibrary(
    local,
    [shared('b', 'x', 'new'), shared('c', 'old')],
    'self',
  );
  expect(result.map(({ id }) => id)).toEqual(['a', 'b', 'c']);
  expect(result[1]).toMatchObject({
    roomOwnerId: 'friend',
    projectHash: 'new',
  });
});
