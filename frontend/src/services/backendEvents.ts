import { isRecord } from '../shared/storage/localStore';

/**
 * Job changes pushed by the local backend (Server-Sent Events relayed by Electron Main). Without the
 * desktop bridge (a plain browser, unit tests) nothing is pushed and callers fall back to polling.
 */
export const backendEventsAvailable = (): boolean =>
  typeof window.desktop?.onBackendEvent === 'function';

// Events update immediately; this slow reconciliation also covers a missed renderer IPC message.
export const backendPollInterval = <T extends number | false>(
  fallback: T,
): number | T =>
  backendEventsAvailable() ? 30_000 : fallback;

const onBackendChange = (
  types: readonly string[],
  listener: (event: { type: string; data: Record<string, unknown> }) => void,
): (() => void) =>
  window.desktop?.onBackendEvent?.((raw) => {
    if (!isRecord(raw) || typeof raw.type !== 'string') return;
    if (['connected', 'resync', ...types].includes(raw.type))
      listener({ type: raw.type, data: isRecord(raw.data) ? raw.data : {} });
  }) ?? (() => undefined);

export const onModelsChange = (listener: () => void): (() => void) =>
  onBackendChange(['models.changed'], listener);

export const onRecordingsChange = (listener: () => void): (() => void) =>
  onBackendChange(['recordings.changed'], listener);

/** A read started before a change/reconnection must not replace the new authoritative state. */
export const readBackendSnapshot = async <T>(
  read: () => Promise<T>,
  types: readonly string[],
  signal?: AbortSignal,
): Promise<T> => {
  let revision = 0;
  const stop = onBackendChange(types, () => {
    revision += 1;
  });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const started = revision;
      try {
        const value = await read();
        signal?.throwIfAborted();
        if (revision === started) return value;
      } catch (error) {
        signal?.throwIfAborted();
        if (revision === started) throw error;
      }
    }
  } finally {
    stop();
  }
};

const libraryListeners = new Set<() => void>();
export const libraryChanged = (): void => {
  libraryListeners.forEach((listener) => listener());
};

/** Progress changes only the jobs view; terminal jobs can change the catalog. */
export const onLibraryChange = (listener: () => void): (() => void) => {
  libraryListeners.add(listener);
  const unsubscribe = onBackendChange(
    ['library.changed', 'job.changed'],
    (event) => {
      if (
        event.type !== 'job.changed' ||
        ([
          'SongImport',
          'SongProcessing',
          'PackageImport',
          'LibraryReconciliation',
        ].includes(String(event.data.type ?? '')) &&
          ['Queued', 'Succeeded', 'Failed', 'Cancelled', 'Interrupted'].includes(
            String(event.data.state ?? ''),
          ))
      )
        listener();
    },
  );
  return () => {
    libraryListeners.delete(listener);
    unsubscribe();
  };
};

/**
 * Calls `listener` with the job id of every job change, and with null after every (re)connection of the
 * stream: changes made while it was down are lost, so the caller refreshes whatever it shows.
 */
export const onJobChange = (
  listener: (jobId: string | null, job?: Record<string, unknown>) => void,
): (() => void) =>
  onBackendChange(['job.changed'], (event) => {
    if (['connected', 'resync'].includes(event.type)) listener(null);
    else if (typeof event.data.jobId === 'string')
      listener(event.data.jobId, event.data);
  });

/** A pushed change can still go missing (a lost connection); this slow check catches it anyway. */
const safetyCheckMilliseconds = 5000;

/**
 * Resolves on the next change of `jobId` (or a reconnection). Create it before reading the job so a change
 * that lands during the read is not missed. Without pushed events it simply waits `pollMilliseconds`.
 */
export const nextJobChange = (
  jobId: string,
  pollMilliseconds: number,
): Promise<void> =>
  nextChange(
    (done) => onJobChange((changed) => {
      if (changed === null || changed === jobId) done();
    }),
    pollMilliseconds,
  );

export const nextRecordingChange = (pollMilliseconds: number): Promise<void> =>
  nextChange(onRecordingsChange, pollMilliseconds);

const nextChange = (
  subscribe: (done: () => void) => () => void,
  pollMilliseconds: number,
): Promise<void> =>
  new Promise((resolve) => {
    let unsubscribe = () => undefined as void;
    const done = () => {
      window.clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = window.setTimeout(
      done,
      backendEventsAvailable() ? safetyCheckMilliseconds : pollMilliseconds,
    );
    unsubscribe = subscribe(done);
  });

/** Calls `refresh` after job changes, at most once per `intervalMilliseconds`; returns the unsubscribe. */
export const refreshOnJobChanges = (
  refresh: () => void,
  intervalMilliseconds: number,
): (() => void) => {
  let timer: number | undefined;
  let last = 0;
  const unsubscribe = onJobChange(() => {
    if (timer !== undefined) return;
    timer = window.setTimeout(
      () => {
        timer = undefined;
        last = Date.now();
        refresh();
      },
      Math.max(0, last + intervalMilliseconds - Date.now()),
    );
  });
  return () => {
    unsubscribe();
    window.clearTimeout(timer);
  };
};
