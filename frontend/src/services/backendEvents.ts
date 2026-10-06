/**
 * Job changes pushed by the local backend (Server-Sent Events relayed by Electron Main). Without the
 * desktop bridge (a plain browser, unit tests) nothing is pushed and callers fall back to polling.
 */
export const backendEventsAvailable = (): boolean =>
  typeof window.desktop?.onBackendEvent === "function";

/**
 * Calls `listener` with the job id of every job change, and with null after every (re)connection of the
 * stream: changes made while it was down are lost, so the caller refreshes whatever it shows.
 */
export const onJobChange = (
  listener: (jobId: string | null) => void,
): (() => void) => {
  const subscribe = window.desktop?.onBackendEvent;
  if (typeof subscribe !== "function") return () => undefined;
  return subscribe((raw) => {
    const event = raw as { type?: unknown; data?: { jobId?: unknown } } | null;
    if (event?.type === "connected") listener(null);
    else if (
      event?.type === "job.changed" &&
      typeof event.data?.jobId === "string"
    )
      listener(event.data.jobId);
  });
};

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
    unsubscribe = onJobChange((changed) => {
      if (changed === null || changed === jobId) done();
    });
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
