import { parentPort } from 'node:worker_threads';
import { waveformPeaks } from './WavPeaks';

interface WaveformWork {
  id: number;
  filePath: string;
  bins: number;
  controller: AbortController;
}

/** One active read; closed previews leave the queue before they touch disk. */
const queued = new Map<number, WaveformWork>();
let active: WaveformWork | undefined;
const drain = async () => {
  if (active) return;
  while (queued.size) {
    const work = queued.values().next().value!;
    queued.delete(work.id);
    active = work;
    try {
      const peaks = await waveformPeaks(
        work.filePath,
        work.bins,
        work.controller.signal,
      );
      work.controller.signal.throwIfAborted();
      parentPort?.postMessage({ id: work.id, peaks });
    } catch (error) {
      parentPort?.postMessage({
        id: work.id,
        error: error instanceof Error ? error.message : String(error),
        code: (error as NodeJS.ErrnoException).code,
        name: error instanceof Error ? error.name : 'Error',
      });
    } finally {
      active = undefined;
    }
  }
};
parentPort?.on(
  'message',
  (message: {
    id: number;
    filePath: string;
    bins: number;
    cancel?: boolean;
  }) => {
    if (message.cancel) {
      if (active?.id === message.id) active.controller.abort();
      else queued.delete(message.id);
      return;
    }
    queued.set(message.id, { ...message, controller: new AbortController() });
    void drain();
  },
);
