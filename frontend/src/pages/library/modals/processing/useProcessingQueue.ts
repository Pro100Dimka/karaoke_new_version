import { useJobs } from '../../../../providers/application';
import { useEffect, useMemo, useState } from 'react';
import type { ProcessingJobDto, SongDto } from '../../../../contracts/models';
import { isInQueue, orderProcessingJobs } from './processingModel';
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
  const imports = useMemo(
    () => [...songs.values()].filter((song) => song.status === 'importing'),
    [songs],
  );
  const cancellable = useMemo(
    () =>
      new Set([
        ...jobs.map((job) => job.id),
        ...imports.flatMap((song) => (song.jobId ? [song.jobId] : [])),
      ]),
    [jobs, imports],
  );
  const busySongs = useMemo(
    () =>
      new Set(
        jobs
          .filter((job) => job.type === 'SongProcessing' && isInQueue(job))
          .map((job) => job.songId),
      ),
    [jobs],
  );
  const stoppable = jobs.filter(
    (job) =>
      job.type === 'SongProcessing' &&
      ['queued', 'processing'].includes(job.state),
  );
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => {
    const stored = readJson(hiddenJobsKey);
    return new Set(
      Array.isArray(stored)
        ? stored.filter((id): id is string => typeof id === 'string')
        : [],
    );
  });
  useEffect(() => writeJson(hiddenJobsKey, [...hidden]), [hidden]);
  // Keep the user's dismissal when a pending file acquires its backend job ID.
  useEffect(() => {
    setHidden((previous) => {
      const aliases = imports.flatMap((song) =>
        song.jobId && previous.has(song.id) && !previous.has(song.jobId)
          ? [song.jobId]
          : [],
      );
      return aliases.length ? new Set([...previous, ...aliases]) : previous;
    });
  }, [imports]);

  const visible = useMemo(() => {
    const jobIds = new Set(jobs.map((job) => job.id));
    const processingSongs = new Set(
      jobs
        .filter((job) => job.type === 'SongProcessing')
        .map((job) => job.songId),
    );
    const pendingByJob = new Map(imports.map((song) => [song.jobId, song]));
    const pending: ProcessingJobDto[] = imports
      .filter((song) => !song.jobId || !jobIds.has(song.jobId))
      .map((song) => ({
        id: song.jobId ?? song.id,
        type: 'SongImport',
        songId: song.id,
        state: 'queued',
        stage: song.stage ?? 'Queued',
        progress: song.progress ?? 0,
        createdAt: song.createdAt,
      }));
    const actual = jobs
      .filter((job) => ['SongImport', 'SongProcessing'].includes(job.type))
      // Import hands off to processing; do not show a second "completed" song card.
      .filter(
        (job) =>
          !(
            job.type === 'SongImport' &&
            job.state === 'completed' &&
            processingSongs.has(job.songId)
          ),
      )
      .map((job) => {
        const song = pendingByJob.get(job.id);
        return song
          ? {
              ...job,
              songId: job.songId || song.id,
              songTitle: job.songTitle ?? song.title,
              songArtist: job.songArtist ?? song.artist,
            }
          : job;
      });
    return [...pending, ...actual].filter(
      (job) =>
        !hidden.has(job.id) &&
        !hidden.has(pendingByJob.get(job.id)?.id ?? job.id),
    );
  }, [jobs, hidden, imports]);
  const ordered = useMemo(
    () => orderProcessingJobs(visible, songs),
    [visible, songs],
  );

  const count = (states: readonly JobState[]) =>
    visible.filter((job) => states.includes(job.state)).length;
  const hide = (ids: readonly string[]) =>
    setHidden((previous) => new Set([...previous, ...ids]));
  return {
    ordered,
    visible,
    failed,
    stoppable,
    count,
    hide,
    canCancel: (id: string) => cancellable.has(id),
    isSongBusy: (id: string) => busySongs.has(id),
  };
};
