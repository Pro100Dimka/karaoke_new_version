export const calibrationOffsetsMilliseconds = [0, 500, 1000, 1500] as const;

export const calibrationDelayMilliseconds = (
  startedAt: string,
  serverNow: string,
  requestRoundTripMilliseconds: number
): number => Math.max(
  0,
  Math.round(
    Date.parse(startedAt) - Date.parse(serverNow)
      - Math.max(0, requestRoundTripMilliseconds) / 2
  )
);

export const scheduleCalibrationClicks = (
  delayMilliseconds: number,
  playClick: () => Promise<void>
): (() => void) => {
  const timers = calibrationOffsetsMilliseconds.map(offset => window.setTimeout(
    () => void playClick().catch(() => undefined),
    Math.max(0, delayMilliseconds + offset)
  ));
  return () => timers.forEach(timer => window.clearTimeout(timer));
};
