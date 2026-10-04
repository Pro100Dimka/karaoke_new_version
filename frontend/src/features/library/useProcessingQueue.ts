import { useEffect, useState } from "react";
import type { ProcessingJobDto } from "../../contracts/models";
import { backendEventsAvailable, refreshOnJobChanges } from "../../services/backendEvents";
import { pythonClient } from "../../services/pythonClient";

const refreshMilliseconds = 1000;
type JobState = ProcessingJobDto["state"];

/**
 * The processing queue while the window is open, re-read when the backend reports a job change; the queued jobs
 * in the order the user arranged them, and cards the user removed from the list kept hidden.
 */
export const useProcessingQueue = (open: boolean, focusSongId?: string) => {
  const [jobs, setJobs] = useState<readonly ProcessingJobDto[]>([]);
  const [failed, setFailed] = useState(false);
  const [queueOrder, setQueueOrder] = useState<readonly string[]>([]);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    let active = true;
    let timer: number | undefined;
    const load = () => pythonClient.listJobs().then(items => {
      if (!active) return;
      setJobs(items);
      setQueueOrder(previous => {
        const queued = items.filter(item => item.state === "queued").map(item => item.id);
        return [...previous.filter(id => queued.includes(id)), ...queued.filter(id => !previous.includes(id))];
      });
      setFailed(false);
    }).catch(() => active && setFailed(true)).finally(() => {
      // Pushed job changes refresh the list; only without them is it polled.
      if (active && !backendEventsAvailable()) timer = window.setTimeout(() => void load(), refreshMilliseconds);
    });
    void load();
    const unsubscribe = refreshOnJobChanges(() => void load(), refreshMilliseconds);
    return () => {
      active = false;
      unsubscribe();
      window.clearTimeout(timer);
    };
  }, [open]);

  const visible = jobs.filter(job => !hidden.has(job.id));
  // The focused song comes first; queued jobs keep their slots but follow the user's order.
  const focused = [...visible].sort((a, b) => Number(b.songId === focusSongId) - Number(a.songId === focusSongId));
  const queued = focused.filter(job => job.state === "queued").sort((a, b) => queueOrder.indexOf(a.id) - queueOrder.indexOf(b.id));
  let next = 0;
  const ordered = focused.map(job => job.state === "queued" ? queued[next++] ?? job : job);

  const count = (states: readonly JobState[]) => visible.filter(job => states.includes(job.state)).length;
  const hide = (ids: readonly string[]) => setHidden(previous => new Set([...previous, ...ids]));
  const move = (jobId: string, direction: -1 | 1) => setQueueOrder(previous => {
    const index = previous.indexOf(jobId);
    const destination = index + direction;
    if (index < 0 || destination < 0 || destination >= previous.length) return previous;
    const swapped = [...previous];
    [swapped[index], swapped[destination]] = [previous[destination] ?? jobId, jobId];
    return swapped;
  });
  const canMove = (jobId: string, direction: -1 | 1) => {
    const destination = queueOrder.indexOf(jobId) + direction;
    return queueOrder.includes(jobId) && destination >= 0 && destination < queueOrder.length;
  };

  return { ordered, visible, failed, count, hide, move, canMove };
};
