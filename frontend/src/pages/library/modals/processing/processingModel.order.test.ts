import { expect, it } from 'vitest';
import type { ProcessingJobDto, SongDto } from '../../../../contracts/models';
import { orderProcessingJobs } from './processingModel';

const job = (
  id: string,
  state: ProcessingJobDto['state'],
  createdAt?: string,
): ProcessingJobDto =>
  ({ id, songId: id, state, createdAt }) as ProcessingJobDto;

it('sorts queued and active jobs first, then creation time, then ID', () => {
  const jobs = [
    job('b', 'completed', '2026-01-02'),
    job('d', 'queued', '2026-01-01'),
    job('c', 'processing', '2026-01-01'),
    job('a', 'completed', '2026-01-01'),
  ];
  const original = [...jobs];
  expect(orderProcessingJobs(jobs, new Map()).map((item) => item.id)).toEqual([
    'c', 'd', 'a', 'b',
  ]);
  expect(jobs).toEqual(original);
});

it('uses the song creation time when present and puts missing dates last', () => {
  const jobs = [
    job('missing', 'failed'),
    job('job', 'failed', '2026-01-01'),
    job('invalid', 'failed', 'invalid'),
  ];
  const songs = new Map([
    ['job', { createdAt: '2026-05-01' } as SongDto],
    ['missing', { createdAt: '2025-01-01' } as SongDto],
  ]);
  expect(orderProcessingJobs(jobs, songs).map((item) => item.id)).toEqual([
    'missing', 'job', 'invalid',
  ]);
});

it('handles empty snapshots and stable ties', () => {
  expect(orderProcessingJobs([], new Map())).toEqual([]);
  expect(
    orderProcessingJobs(
      [job('z', 'cancelled'), job('a', 'cancelled')],
      new Map(),
    ).map((item) => item.id),
  ).toEqual(['a', 'z']);
});
