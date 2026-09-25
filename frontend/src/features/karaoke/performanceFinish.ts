/** Shares a finalizer's result among concurrent room events; later retries remain possible. */
export const createSingleFlight = <T>(work: () => Promise<T>): (() => Promise<T>) => {
  let flight: Promise<T> | undefined;
  return () => {
    flight ??= work().finally(() => { flight = undefined; });
    return flight;
  };
};
