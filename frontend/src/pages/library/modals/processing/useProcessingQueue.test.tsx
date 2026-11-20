import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProcessingJobDto, SongDto } from '../../../../contracts/models';
import { compareAddedSongs } from '../../songs/librarySelectors';
import { useProcessingQueue } from './useProcessingQueue';
import { clearStorage } from '../../../../shared/storage/localStore';

const snapshot = vi.hoisted(() => ({
  jobs: [] as ProcessingJobDto[],
  failed: false,
}));
vi.mock('../../../../providers/application', () => ({
  useJobs: () => snapshot,
}));

const song = (
  id: string,
  status: SongDto['status'],
  createdAt: string,
): SongDto => ({
  id,
  title: id,
  artist: '',
  language: 'Auto',
  status,
  progress: 0,
  stage: 'Queued',
  durationSeconds: 0,
  createdAt,
  coverState: 'Fallback',
  activeRevision: 0,
  projectFormatVersion: 1,
});
const job = (id: string): ProcessingJobDto => ({
  id: `job:${id}`,
  songId: id,
  type: 'SongProcessing',
  state: 'queued',
  stage: 'Queued',
  progress: 0,
});

beforeEach(() => {
  clearStorage();
  snapshot.jobs = [job('one'), job('two')];
});
afterEach(() => {
  cleanup();
  clearStorage();
});

it('shows all twenty selected songs when only two processing jobs have been created', () => {
  const pending = Array.from({ length: 18 }, (_, i) =>
    song(`import:${17 - i}`, 'importing', '2026-11-14'),
  );
  const songs = [
    ...pending,
    song('two', 'queued', '2026-11-13'),
    song('one', 'processing', '2026-11-12'),
  ];
  const byId = new Map(songs.map((item) => [item.id, item]));
  const { result } = renderHook(() => useProcessingQueue(byId));
  expect(result.current.visible).toHaveLength(20);
  expect(result.current.ordered.map((item) => item.songId)).toEqual(
    [...songs]
      .sort((a, b) => compareAddedSongs(a, b, 'desc'))
      .map((item) => item.id),
  );
  expect(result.current.count(['queued'])).toBe(20);
});

it('replaces an import entry with its real processing job without duplicating the song', () => {
  const pending = song('import:next', 'importing', '2026-11-14');
  const old = song('one', 'queued', '2026-11-12');
  snapshot.jobs = [job('one')];
  const { result, rerender } = renderHook(
    ({ songs }) => useProcessingQueue(songs),
    {
      initialProps: {
        songs: new Map([pending, old].map((item) => [item.id, item])),
      },
    },
  );
  expect(result.current.visible).toHaveLength(2);
  snapshot.jobs = [job('next'), job('one')];
  rerender({
    songs: new Map(
      [song('next', 'queued', '2026-11-14'), old].map((item) => [
        item.id,
        item,
      ]),
    ),
  });
  expect(result.current.ordered.map((item) => item.songId)).toEqual([
    'next',
    'one',
  ]);
  expect(
    result.current.visible.some((item) => item.songId === pending.id),
  ).toBe(false);
});

it('hides an import card without removing the actual pending import', () => {
  const pending = song('import:next', 'importing', '2026-11-14');
  const songs = new Map([[pending.id, pending]]);
  const { result } = renderHook(() => useProcessingQueue(songs));
  expect(
    result.current.visible.some((item) => item.songId === pending.id),
  ).toBe(true);
  const entry = result.current.visible.find(
    (item) => item.songId === pending.id,
  )!;
  act(() => result.current.hide([entry.id]));
  expect(
    result.current.visible.some((item) => item.songId === pending.id),
  ).toBe(false);
  expect(songs.get(pending.id)).toBe(pending);
});

it('reconciles a running import with its named placeholder and real cancellable job', () => {
  const pending = {
    ...song('import:next', 'importing', '2026-11-14'),
    jobId: 'import-job',
  };
  snapshot.jobs = [
    {
      ...job(''),
      id: 'import-job',
      type: 'SongImport',
      state: 'processing',
      progress: 42,
    },
  ];
  const { result } = renderHook(() =>
    useProcessingQueue(new Map([[pending.id, pending]])),
  );
  expect(result.current.visible).toEqual([
    expect.objectContaining({
      id: 'import-job',
      songId: pending.id,
      state: 'processing',
      progress: 42,
    }),
  ]);
});

it('keeps a hidden placeholder hidden when the import receives its backend identity', () => {
  const pending = song('import:next', 'importing', '2026-11-14');
  snapshot.jobs = [];
  const { result, rerender } = renderHook(
    ({ item }) => useProcessingQueue(new Map([[item.id, item]])),
    {
      initialProps: { item: pending },
    },
  );
  act(() => result.current.hide([pending.id]));
  snapshot.jobs = [
    { ...job(''), id: 'import-job', type: 'SongImport', state: 'processing' },
  ];
  rerender({ item: { ...pending, jobId: 'import-job' } });
  expect(result.current.visible).toEqual([]);
  rerender({ item: { ...pending, id: 'saved-song', status: 'not-processed' } });
  expect(result.current.visible).toEqual([]);
});

it('keeps model, archive and recording jobs out of the song processing queue', () => {
  snapshot.jobs = [
    'SongProcessing',
    'SongImport',
    'ModelDownload',
    'RecordingMastering',
    'LibraryExport',
  ].map((type) => ({ ...job(type), type }));
  const { result } = renderHook(() => useProcessingQueue(new Map()));
  expect(result.current.visible.map((item) => item.type)).toEqual([
    'SongProcessing',
    'SongImport',
  ]);
});

it('hands a completed import card over to the song processing job', () => {
  const imported = song('next', 'processing', '2026-11-14');
  snapshot.jobs = [
    {
      ...job('next'),
      id: 'import-job',
      type: 'SongImport',
      state: 'completed',
    },
    { ...job('next'), state: 'processing', progress: 25 },
  ];
  const { result } = renderHook(() =>
    useProcessingQueue(new Map([[imported.id, imported]])),
  );
  expect(result.current.visible).toEqual([
    expect.objectContaining({
      id: 'job:next',
      type: 'SongProcessing',
      state: 'processing',
    }),
  ]);
});
