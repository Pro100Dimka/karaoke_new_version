import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

type ComputePeaks = (
  filePath: string,
  bins: number,
  signal?: AbortSignal,
) => Promise<number[]>;

const cachedFiles = 256;

/**
 * Peaks computed in a worker thread: reading a take's whole WAV must never hold up the main
 * process, which carries the windows' input and every IPC call. One worker, started on first use
 * and restarted if it dies; requests queue in it one after another.
 */
const workerPeaks = (
  script = path.join(__dirname, 'WavPeaksWorker.js'),
): ComputePeaks => {
  let worker: Worker | null = null;
  let nextId = 0;
  const pending = new Map<
    number,
    {
      resolve(peaks: number[]): void;
      reject(error: Error): void;
      release(): void;
    }
  >();
  const failAll = (error: Error) => {
    for (const request of pending.values()) {
      request.release();
      request.reject(error);
    }
    pending.clear();
    worker = null;
  };
  const start = () => {
    const started = new Worker(script);
    started.unref();
    started.on(
      'message',
      (message: {
        id: number;
        peaks?: number[];
        error?: string;
        code?: string;
        name?: string;
      }) => {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        request.release();
        if (message.peaks) return request.resolve(message.peaks);
        const error: NodeJS.ErrnoException = new Error(
          message.error ?? 'Peaks failed',
        );
        if (message.code) error.code = message.code;
        if (message.name) error.name = message.name;
        request.reject(error);
      },
    );
    started.on('error', failAll);
    started.on('exit', () => {
      if (worker === started) failAll(new Error('Peaks worker stopped'));
    });
    return started;
  };
  return (filePath, bins, signal) =>
    new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      if (pending.size >= cachedFiles) {
        reject(new Error('Waveform queue is full'));
        return;
      }
      worker ??= start();
      const current = worker;
      const id = ++nextId;
      const release = () => signal?.removeEventListener('abort', cancel);
      const cancel = () => {
        pending.delete(id);
        release();
        current.postMessage({ id, cancel: true });
        reject(signal?.reason);
      };
      pending.set(id, { resolve, reject, release });
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        current.postMessage({ id, filePath, bins });
      } catch (error) {
        pending.delete(id);
        release();
        reject(error);
      }
    });
};

/**
 * Peaks by file, remembered while the file stays the same (path, size and modification time): a
 * take's list opens instantly the second time, and the same file asked for twice is read once.
 */
export const createPeaksService = (compute: ComputePeaks = workerPeaks()) => {
  const cache = new Map<string, number[]>();
  const pending = new Map<
    string,
    {
      controller: AbortController;
      readers: number;
      promise: Promise<number[]>;
    }
  >();
  return async (
    filePath: string,
    bins: number,
    signal?: AbortSignal,
  ): Promise<number[]> => {
    signal?.throwIfAborted();
    const file = await stat(filePath);
    signal?.throwIfAborted();
    const key = `${filePath}|${file.size}|${file.mtimeMs}|${bins}`;
    const known = cache.get(key);
    if (known) {
      // The most recently used stay longest.
      cache.delete(key);
      cache.set(key, known);
      return known;
    }
    let entry = pending.get(key);
    if (!entry) {
      const controller = new AbortController();
      const started = {
        controller,
        readers: 0,
        promise: Promise.resolve<number[]>([]),
      };
      started.promise = Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return compute(filePath, bins, controller.signal);
        })
        .then((peaks) => {
          controller.signal.throwIfAborted();
          cache.set(key, peaks);
          for (const oldest of cache.keys()) {
            if (cache.size <= cachedFiles) break;
            cache.delete(oldest);
          }
          return peaks;
        })
        .finally(() => {
          if (pending.get(key) === started) pending.delete(key);
        });
      pending.set(key, started);
      entry = started;
    }
    const current = entry;
    current.readers += 1;
    let cancel = () => {};
    try {
      return await new Promise<number[]>((resolve, reject) => {
        cancel = () => reject(signal?.reason);
        signal?.addEventListener('abort', cancel, { once: true });
        current.promise.then(resolve, reject);
      });
    } finally {
      signal?.removeEventListener('abort', cancel);
      current.readers -= 1;
      // Shared reads outlive one closed card, but never their last consumer.
      if (!current.readers && pending.get(key) === current) {
        pending.delete(key);
        current.controller.abort();
      }
    }
  };
};
