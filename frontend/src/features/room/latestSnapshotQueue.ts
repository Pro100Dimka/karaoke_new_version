export interface LatestSnapshotQueue<T> {
  push(value: T): Promise<void>;
  idle(): Promise<void>;
}

/** Serializes snapshot side effects while collapsing a burst to its newest state. */
export const createLatestSnapshotQueue = <T>(
  handle: (value: T) => Promise<void>,
): LatestSnapshotQueue<T> => {
  let pending: T | undefined;
  let running: Promise<void> | undefined;

  const drain = async (): Promise<void> => {
    while (pending !== undefined) {
      const value = pending;
      pending = undefined;
      await handle(value);
    }
  };

  return {
    push(value) {
      pending = value;
      if (!running) {
        running = drain().finally(() => { running = undefined; });
      }
      return running;
    },
    idle() {
      return running ?? Promise.resolve();
    },
  };
};
