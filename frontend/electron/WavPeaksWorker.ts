import { parentPort } from "node:worker_threads";
import { waveformPeaks } from "./WavPeaks";

/** Computes waveform peaks off the main process's thread (PeaksService starts it). */
parentPort?.on(
  "message",
  async ({ id, filePath, bins }: { id: number; filePath: string; bins: number }) => {
    try {
      parentPort?.postMessage({ id, peaks: await waveformPeaks(filePath, bins) });
    } catch (error) {
      parentPort?.postMessage({
        id,
        error: error instanceof Error ? error.message : String(error),
        code: (error as NodeJS.ErrnoException).code,
      });
    }
  },
);
