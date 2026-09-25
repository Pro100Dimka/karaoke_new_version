import { useEffect, useRef } from "react";
import { audioClient } from "../../services/audioClient";
import { useServices } from "../ServicesContext";

const pollMilliseconds = 50;
const bassBandCount = 3;
const activeThreshold = 0.04;

export interface SpectrumFrame {
  bands: readonly number[];
  bass: number;
  active: boolean;
}

export const toSpectrumFrame = (bands: readonly number[]): SpectrumFrame => {
  const bassBands = bands.slice(0, bassBandCount);
  return {
    bands,
    bass: bassBands.length === 0 ? 0 : bassBands.reduce((sum, level) => sum + level, 0) / bassBands.length,
    active: bands.some(level => level > activeThreshold)
  };
};

/**
 * Feeds the backdrop with the output spectrum measured by AudioService. One request is in flight at a time and
 * polling stops while the service is not ready or the window is hidden, so it never queues behind real commands.
 */
export const useSpectrumFeed = (enabled: boolean, onFrame: (frame: SpectrumFrame) => void): void => {
  const { audio } = useServices();
  const ready = audio.kind === "ready";
  const inFlight = useRef(false);

  useEffect(() => {
    if (!enabled || !ready) return;
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      if (stopped) return;
      if (!inFlight.current) {
        inFlight.current = true;
        try {
          const bands = await audioClient.spectrum();
          if (!stopped) onFrame(toSpectrumFrame(bands));
        } catch {
          // The service health polling reports outages; the animation simply idles.
        } finally {
          inFlight.current = false;
        }
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), pollMilliseconds);
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [enabled, ready, onFrame]);
};
