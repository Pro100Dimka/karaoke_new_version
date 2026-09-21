import { useEffect, useRef, useState } from "react";

/** Polls arrive every ~100 ms; a poll that agrees with the running prediction keeps the current anchor so the motion never stutters. */
const resyncThresholdSeconds = 0.08;

/**
 * Position for animation: between authoritative AudioService positions it advances on animation frames at the playback rate.
 * The value is only for drawing (piano roll, word highlight); the real clock still comes from the polled position.
 */
export const useSmoothPosition = (polledSeconds: number, playing: boolean, rate: number): number => {
  const [smooth, setSmooth] = useState(polledSeconds);
  const anchor = useRef({ seconds: polledSeconds, at: performance.now() });

  useEffect(() => {
    const now = performance.now();
    const predicted = anchor.current.seconds + ((now - anchor.current.at) / 1000) * rate;
    if (!playing || Math.abs(predicted - polledSeconds) > resyncThresholdSeconds) anchor.current = { seconds: polledSeconds, at: now };
    if (!playing) setSmooth(polledSeconds);
  }, [polledSeconds, playing, rate]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = (now: number) => {
      setSmooth(anchor.current.seconds + ((now - anchor.current.at) / 1000) * rate);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, rate]);

  return smooth;
};
