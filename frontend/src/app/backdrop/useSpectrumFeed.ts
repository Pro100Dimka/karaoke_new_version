import { useEffect, useRef } from "react";
import { audioClient } from "../../services/audioClient";
import { useServices } from "../ServicesContext";

const pollMilliseconds = 50;
const bassBandCount = 3;
const activeThreshold = 0.04;

export interface SpectrumFrame {
  bands: readonly number[];
  backingBands: readonly number[];
  bass: number;
  active: boolean;
}

const average = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

/** Visual pulse driven by kick/bass, snare/toms and bright percussion in the rendered mix. */
export const percussionLevel = (bands: readonly number[]): number => Math.min(1, Math.max(
  average(bands.slice(0, 3)) * 1.5,
  average(bands.slice(3, 8)) * 1.35,
  average(bands.slice(8, 16)) * 1.15
));

export interface PercussionReaction {
  kick: number;
  snare: number;
  pulse: number;
}

/**
 * Converts the logarithmic spectrum into short visual transients. Spectral flux catches the attack of a drum
 * instead of leaving the UI permanently enlarged by a sustained bass note; a small energy floor keeps softer
 * kick, snare and tom hits visible after AudioService smoothing.
 */
export const createPercussionReaction = () => {
  let previous: readonly number[] = [];
  let kickEnvelope = 0;
  let snareEnvelope = 0;
  const bandReaction = (bands: readonly number[], from: number, to: number, gain: number) => {
    const energy = average(bands.slice(from, to));
    const flux = average(bands.slice(from, to).map((level, index) =>
      Math.max(0, level - (previous[from + index] ?? 0))));
    return Math.min(1, flux * gain + Math.max(0, energy - 0.1) * 0.35);
  };
  const follow = (current: number, target: number) => target >= current ? target : current * 0.68;

  return {
    next(bands: readonly number[]): PercussionReaction {
      const kickTarget = bandReaction(bands, 0, 4, 2.8);
      const snareTarget = Math.max(
        bandReaction(bands, 4, 9, 2.7),
        bandReaction(bands, 9, 14, 2.4)
      );
      kickEnvelope = follow(kickEnvelope, kickTarget);
      snareEnvelope = follow(snareEnvelope, snareTarget);
      previous = [...bands];
      return { kick: kickEnvelope, snare: snareEnvelope, pulse: Math.max(kickEnvelope, snareEnvelope) };
    }
  };
};

export const toSpectrumFrame = (bands: readonly number[], backingBands: readonly number[] = bands): SpectrumFrame => {
  const bassBands = bands.slice(0, bassBandCount);
  return {
    bands,
    backingBands: backingBands.length > 0 ? backingBands : bands,
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
          const { bands, backingBands } = await audioClient.spectrum();
          if (!stopped) onFrame(toSpectrumFrame(bands, backingBands));
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
