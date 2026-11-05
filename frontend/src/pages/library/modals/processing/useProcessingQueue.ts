import { useJobs } from '../../../../providers/application';
import { useEffect, useMemo, useState } from 'react';
import type { ProcessingJobDto, SongDto } from '../../../../contracts/models';
import { isInQueue } from './processingModel';
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

  const visible = useMemo(
    () => jobs.filter((job) => !hidden.has(job.id)),
    [jobs, hidden],
  );
  const ordered = useMemo(() => {
    const addedAt = (job: ProcessingJobDto) =>
      Date.parse(songs.get(job.songId)?.createdAt ?? job.createdAt ?? '') ||
      Infinity;
    return [...visible].sort((a, b) =>
      Number(isInQueue(b)) - Number(isInQueue(a)) ||
      addedAt(a) - addedAt(b) ||
      a.id.localeCompare(b.id),
    );
  }, [visible, songs]);

  const count = (states: readonly JobState[]) =>
    visible.filter((job) => states.includes(job.state)).length;
  const hide = (ids: readonly string[]) =>
    setHidden((previous) => new Set([...previous, ...ids]));
  return { ordered, visible, failed, count, hide };
};
