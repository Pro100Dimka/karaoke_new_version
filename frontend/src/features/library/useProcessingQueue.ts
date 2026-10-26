import { useApp } from "../../app/AppContext";
import { useEffect, useState } from "react";
import type { ProcessingJobDto } from "../../contracts/models";
import { readJson, storageKey, writeJson } from "../../shared/storage/localStore";

type JobState = ProcessingJobDto["state"];
const hiddenJobsKey = storageKey("processingQueue.hidden");

/**
 * Local ordering and hidden cards over the shared job snapshot. Opening this window does not start
 * another backend subscription or polling loop.
 */
export const useProcessingQueue = (open: boolean, focusSongId?: string) => {
  const { jobs, failed } = useApp("jobs");
  const [queueOrder, setQueueOrder] = useState<readonly string[]>([]);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => {
    const stored = readJson(hiddenJobsKey);
    return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : []);
  });
  useEffect(() => writeJson(hiddenJobsKey, [...hidden]), [hidden]);

  useEffect(() => {
    if (!open) return;
    const queued = jobs.filter((job) => job.state === "queued").map((job) => job.id);
    setQueueOrder((previous) => [
      ...previous.filter((id) => queued.includes(id)),
      ...queued.filter((id) => !previous.includes(id)),
    ]);
  }, [open, jobs]);

  const visible = jobs.filter((job) => !hidden.has(job.id));
  // The focused song comes first; queued jobs keep their slots but follow the user's order.
  const focused = [...visible].sort(
    (a, b) =>
      Number(b.songId === focusSongId) - Number(a.songId === focusSongId),
  );
  const queued = focused
    .filter((job) => job.state === "queued")
    .sort((a, b) => queueOrder.indexOf(a.id) - queueOrder.indexOf(b.id));
  let next = 0;
  const ordered = focused.map((job) =>
    job.state === "queued" ? (queued[next++] ?? job) : job,
  );

  const count = (states: readonly JobState[]) =>
    visible.filter((job) => states.includes(job.state)).length;
  const hide = (ids: readonly string[]) =>
    setHidden((previous) => new Set([...previous, ...ids]));
  const move = (jobId: string, direction: -1 | 1) =>
    setQueueOrder((previous) => {
      const index = previous.indexOf(jobId);
      const destination = index + direction;
      if (index < 0 || destination < 0 || destination >= previous.length)
        return previous;
      const swapped = [...previous];
      [swapped[index], swapped[destination]] = [
        previous[destination] ?? jobId,
        jobId,
      ];
      return swapped;
    });
  const canMove = (jobId: string, direction: -1 | 1) => {
    const destination = queueOrder.indexOf(jobId) + direction;
    return (
      queueOrder.includes(jobId) &&
      destination >= 0 &&
      destination < queueOrder.length
    );
  };

  return { ordered, visible, failed, count, hide, move, canMove };
};
