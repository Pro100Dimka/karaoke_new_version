/** How AudioService's monotonic clock (ns) maps onto performance.now() (ms). */
export interface NativeClockSample {
  offset: number;
  roundTrip: number;
  measuredAt: number;
}

// The mapping error is up to half a request's round trip, so the shortest round trip wins. Both
// clocks come from the same performance counter, so the kept sample ages only by 1 ms of round trip
// per 100 s: enough to recover from a lost fast sample, never enough to let a slow one in.
const agingPerMillisecond = 1 / 100_000;
const samplesPerRefresh = 5;

/** Keeps `current` unless the new reading came back at least as fast as it (after aging). */
export const acceptClockSample = (
  current: NativeClockSample | undefined,
  ticksNanoseconds: number,
  startedAt: number,
  receivedAt: number,
): NativeClockSample | undefined => {
  if (!Number.isFinite(ticksNanoseconds) || ticksNanoseconds <= 0) return current;
  const roundTrip = receivedAt - startedAt;
  if (current && roundTrip > current.roundTrip + (receivedAt - current.measuredAt) * agingPerMillisecond)
    return current;
  return { offset: ticksNanoseconds / 1e6 - (startedAt + receivedAt) / 2, roundTrip, measuredAt: receivedAt };
};

/** A few quick clock reads right before a schedule is converted: the fastest one sets the mapping. */
export const refreshNativeClock = async (
  current: NativeClockSample | undefined,
  readTicks: () => Promise<string>,
): Promise<NativeClockSample | undefined> => {
  let best = current;
  for (let sample = 0; sample < samplesPerRefresh; sample += 1) {
    const startedAt = performance.now();
    const reply = await readTicks();
    const receivedAt = performance.now();
    best = acceptClockSample(best, Number(/MonotonicTicks: (\d+)/.exec(reply)?.[1]), startedAt, receivedAt);
  }
  return best;
};
