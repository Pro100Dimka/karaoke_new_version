import type { ProcessingJobDto } from '../contracts/models';
import { onJobChange } from './backendEvents';
import { mapJob } from './pythonMappers';
import { isRecord } from '../shared/storage/localStore';

type JobState = ProcessingJobDto['state'];

/** Event IDs select authoritative detail reads; structural changes still need the whole list. */
export const createJobSnapshotReader = (
  read: (
    ids?: readonly string[],
    signal?: AbortSignal,
  ) => Promise<readonly ProcessingJobDto[]>,
  current: () => readonly ProcessingJobDto[] | undefined,
) => {
  const changed = new Map<string, number>();
  let revision = 0;
  let fullRevision = 0;
  let acceptedFullRevision = -1;
  let lastFullRead = -Infinity;
  return {
    changed(id: string | null) {
      if (id === null) fullRevision = ++revision;
      else changed.set(id, ++revision);
    },
    async read(signal: AbortSignal, fromEvent: boolean) {
      const base = current();
      const known = new Set(base?.map((job) => job.id));
      let full = false;
      let observedFullRevision = -1;
      let observed = new Map<string, number>();
      const fullRead = async () => {
        signal.throwIfAborted();
        if (!full) fullRevision = ++revision;
        full = true;
        observedFullRevision = fullRevision;
        return read(undefined, signal);
      };
      const value = await readJobSnapshot(
        async () => {
          signal.throwIfAborted();
          // A retry keeps every unacknowledged ID, including other jobs that
          // changed while the previous detail read was still in flight.
          observed = new Map(changed);
          const ids = [...observed.keys()];
          if (
            full ||
            !fromEvent ||
            !base ||
            !ids.length ||
            fullRevision !== acceptedFullRevision ||
            Date.now() - lastFullRead >= 30_000 ||
            Date.now() < lastFullRead ||
            ids.some((id) => !known.has(id))
          )
            return fullRead();
          let updates: readonly ProcessingJobDto[];
          try {
            updates = await read(ids, signal);
          } catch (error) {
            signal.throwIfAborted();
            if (
              !isRecord(error) ||
              !['JobNotFound', 'InvalidJobSnapshot'].includes(
                String(error.code),
              )
            )
              throw error;
            return fullRead();
          }
          signal.throwIfAborted();
          const byId = new Map(updates.map((job) => [job.id, job]));
          if (
            updates.length !== ids.length ||
            byId.size !== ids.length ||
            ids.some((id) => !byId.has(id))
          )
            return fullRead();
          return base.map((job) => byId.get(job.id) ?? job);
        },
        (jobs) => new Map(jobs.map((job) => [job.id, job.state])),
        signal,
      );
      signal.throwIfAborted();
      // HTTP success alone is not acceptance: readJobSnapshot may reject it
      // after a concurrent transition. Newer per-ID events remain pending.
      for (const [id, seen] of observed)
        if (changed.get(id) === seen) changed.delete(id);
      if (full) {
        acceptedFullRevision = observedFullRevision;
        lastFullRead = Date.now();
      }
      return value;
    },
  };
};

/**
 * Progress may arrive faster than a paged job read can finish. Accept that read
 * when it contains the changed jobs in their current states; keep a fresh-read
 * barrier for terminal details, missing jobs, incomplete events and reconnects.
 */
export const readJobSnapshot = async <T>(
  read: () => Promise<T>,
  states: (value: T) => ReadonlyMap<string, JobState>,
  signal: AbortSignal,
  target?: { type: string; entityId: string },
): Promise<T> => {
  signal.throwIfAborted();
  let invalidated = false;
  const changes = new Map<string, JobState>();
  const unsubscribe = onJobChange((id, job) => {
    if (
      target &&
      ((typeof job?.type === 'string' && job.type !== target.type) ||
        (typeof job?.entityId === 'string' && job.entityId !== target.entityId))
    )
      return;
    if (
      id === null ||
      !['Queued', 'Running', 'Cancelling'].includes(String(job?.state)) ||
      typeof job?.overallProgress !== 'number' ||
      !Number.isFinite(job.overallProgress) ||
      typeof job.stageProgress !== 'number' ||
      !Number.isFinite(job.stageProgress)
    ) {
      invalidated = true;
      return;
    }
    changes.set(id, mapJob({ jobId: id, state: String(job.state) }).state);
  });
  let listening = true;
  const stop = () => {
    if (!listening) return;
    listening = false;
    unsubscribe();
  };
  signal.addEventListener('abort', stop, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      invalidated = false;
      changes.clear();
      const value = await read();
      signal.throwIfAborted();
      if (invalidated) continue;
      if (!changes.size) return value;
      const current = states(value);
      if ([...changes].every(([id, state]) => current.get(id) === state))
        return value;
    }
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    stop();
    signal.removeEventListener('abort', stop);
  }
};
