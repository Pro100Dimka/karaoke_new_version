import { stat } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";

export type ComputePeaks = (filePath: string, bins: number) => Promise<number[]>;

const cachedFiles = 256;

/**
 * Peaks computed in a worker thread: reading a take's whole WAV must never hold up the main
 * process, which carries the windows' input and every IPC call. One worker, started on first use
 * and restarted if it dies; requests queue in it one after another.
 */
export const workerPeaks = (
  script = path.join(__dirname, "WavPeaksWorker.js"),
): ComputePeaks => {
  let worker: Worker | null = null;
  let nextId = 0;
  const pending = new Map<number, { resolve(peaks: number[]): void; reject(error: Error): void }>();
  const failAll = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    worker = null;
  };
  const start = () => {
    const started = new Worker(script);
    started.unref();
    started.on("message", (message: { id: number; peaks?: number[]; error?: string; code?: string }) => {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.peaks) return request.resolve(message.peaks);
      const error: NodeJS.ErrnoException = new Error(message.error ?? "Peaks failed");
      if (message.code) error.code = message.code;
      request.reject(error);
    });
    started.on("error", failAll);
    started.on("exit", () => {
      if (worker === started) failAll(new Error("Peaks worker stopped"));
    });
    return started;
  };
  return (filePath, bins) =>
    new Promise((resolve, reject) => {
      if (pending.size >= cachedFiles) {
        reject(new Error("Waveform queue is full"));
        return;
      }
      worker ??= start();
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, filePath, bins });
    });
};

/**
 * Peaks by file, remembered while the file stays the same (path, size and modification time): a
 * take's list opens instantly the second time, and the same file asked for twice is read once.
 */
export const createPeaksService = (compute: ComputePeaks = workerPeaks()) => {
  const cache = new Map<string, Promise<number[]>>();
  return async (filePath: string, bins: number): Promise<number[]> => {
    const file = await stat(filePath);
    const key = `${filePath}|${file.size}|${file.mtimeMs}|${bins}`;
    const known = cache.get(key);
    if (known) {
      // The most recently used stay longest.
      cache.delete(key);
      cache.set(key, known);
      return known;
    }
    const peaks = compute(filePath, bins);
    cache.set(key, peaks);
    peaks.catch(() => cache.delete(key));
    for (const oldest of cache.keys()) {
      if (cache.size <= cachedFiles) break;
      cache.delete(oldest);
    }
    return peaks;
  };
};
