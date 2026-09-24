/** Runs a karaoke-session finalizer once and shares its result with every concurrent room event. */
export const createSingleFlight = <T>(work: () => Promise<T>): (() => Promise<T>) => {
  let flight: Promise<T> | undefined;
  return () => {
    flight ??= work();
    return flight;
  };
};
