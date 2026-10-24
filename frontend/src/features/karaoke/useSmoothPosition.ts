import { useEffect, useRef, useState } from "react";

/** Only a seek snaps the drawing; ordinary IPC jitter is corrected gradually. */
const resyncThresholdSeconds = 0.5;

/**
 * Position for animation: between authoritative AudioService positions it advances on animation frames at the playback rate.
 * The value is only for drawing (piano roll, word highlight); the real clock still comes from the polled position.
 */
export const useSmoothPosition = (
  polledSeconds: number,
  playing: boolean,
  rate: number,
): number => {
  const [smooth, setSmooth] = useState(polledSeconds);
  const anchor = useRef({
    seconds: polledSeconds, at: performance.now(), playing, rate,
  });
  const correction = useRef(0);
  const lastPolled = useRef(polledSeconds);

  useEffect(() => {
    const now = performance.now();
    const previous = anchor.current;
    const receivedPosition = lastPolled.current !== polledSeconds;
    lastPolled.current = polledSeconds;
    const predicted =
      previous.seconds + (previous.playing
        ? ((now - previous.at) / 1000) * previous.rate : 0);
    if (
      !playing ||
      playing !== previous.playing ||
      Math.abs(predicted - polledSeconds) > resyncThresholdSeconds
    ) {
      anchor.current = { seconds: polledSeconds, at: now, playing, rate };
      correction.current = 0;
    } else {
      if (receivedPosition) correction.current = polledSeconds - predicted;
      if (rate !== previous.rate)
        anchor.current = { seconds: predicted, at: now, playing, rate };
    }
    if (!playing) setSmooth(polledSeconds);
  }, [polledSeconds, playing, rate]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let previousAt = performance.now();
    const tick = (now: number) => {
      const elapsed = Math.max(0, (now - previousAt) / 1000);
      previousAt = now;
      const limit = elapsed * rate * 0.5;
      const adjustment = Math.max(-limit, Math.min(limit, correction.current * (1 - Math.exp(-elapsed / 0.25))));
      anchor.current.seconds += adjustment;
      correction.current -= adjustment;
      setSmooth(
        anchor.current.seconds + ((now - anchor.current.at) / 1000) * rate,
      );
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, rate]);

  return smooth;
};
