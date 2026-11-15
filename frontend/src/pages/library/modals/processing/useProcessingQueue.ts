import { useJobs } from '../../../../providers/application';
import { useEffect, useMemo, useState } from 'react';
import type { ProcessingJobDto, SongDto } from '../../../../contracts/models';
import { orderProcessingJobs } from './processingModel';
import {
  readJson,
  storageKey,
  writeJson,
} from '../../../../shared/storage/localStore';

type JobState = ProcessingJobDto['state'];
const hiddenJobsKey = storageKey('processingQueue.hidden');

/**
 * Hidden cards over the shared job snapshot. Opening this window does not start
 * another backend subscription or polling loop.
 */
export const useProcessingQueue = (songs: ReadonlyMap<string, SongDto>) => {
  const { jobs, failed } = useJobs();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => {
    const stored = readJson(hiddenJobsKey);
    return new Set(
      Array.isArray(stored)
        ? stored.filter((id): id is string => typeof id === 'string')
        : [],
    );
  });
  useEffect(() => writeJson(hiddenJobsKey, [...hidden]), [hidden]);

  const visible = useMemo(() => {
    const imports: ProcessingJobDto[] = [...songs.values()]
      .filter((song) => song.status === 'importing')
      .map((song) => ({
        id: song.id,
        type: 'SongImport',
        songId: song.id,
        state: 'queued',
        stage: song.stage ?? 'Queued',
        progress: song.progress ?? 0,
        createdAt: song.createdAt,
      }));
    return [...imports, ...jobs].filter((job) => !hidden.has(job.id));
  }, [jobs, hidden, songs]);
  const ordered = useMemo(
    () => orderProcessingJobs(visible, songs),
    [visible, songs],
  );

  const count = (states: readonly JobState[]) =>
    visible.filter((job) => states.includes(job.state)).length;
  const hide = (ids: readonly string[]) =>
    setHidden((previous) => new Set([...previous, ...ids]));
  return { ordered, visible, failed, count, hide };
};
