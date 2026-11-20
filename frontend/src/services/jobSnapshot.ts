import type { ProcessingJobDto } from '../contracts/models';
import { onJobChange } from './backendEvents';
import { mapJob } from './pythonMappers';

type JobState = ProcessingJobDto['state'];

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
