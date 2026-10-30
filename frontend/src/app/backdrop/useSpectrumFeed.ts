import { store } from "../../providers/store";
import { useEffect, useRef } from "react";
import { audioClient } from "../../services/audioClient";


// Silence draws nothing new, so it is sampled rarely; after a second of full-rate silent frames every
// music-driven visual has decayed to rest, and the first audible frame restores the full rate.
const silentPollMilliseconds = 250;
const silenceLevel = 0.001;
const isSilent = (frame: SpectrumFrame): boolean =>
  [...frame.bands, ...frame.backingBands].every(
    (level) => level <= silenceLevel,
  );
const bassBandCount = 3;
const activeThreshold = 0.04;

export interface SpectrumFrame {
  bands: readonly number[];
  backingBands: readonly number[];
  bass: number;
  active: boolean;
}

const average = (values: readonly number[]): number =>
  values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
export interface PercussionReaction {
  kick: number;
  snare: number;
  pulse: number;
}

/**
 * Converts the logarithmic spectrum into short visual transients. Spectral flux catches the attack of a drum
 * instead of leaving the UI permanently enlarged by a sustained bass note. Kick and snare ranges
 * normalize their attacks independently, so quieter hits remain visible after a loud passage.
 */
export const createPercussionReaction = () => {
  let previous: readonly number[] = [];
  const channels = {
    kick: { from: 0, to: 5, coverage: 0.6, peak: 0.015, mean: 0, cooldown: 0, envelope: 0 },
    snare: { from: 5, to: 17, coverage: 0.6, peak: 0.015, mean: 0, cooldown: 0, envelope: 0 },
  };

  return {
    next(bands: readonly number[], elapsed = 0.05): PercussionReaction {
      for (const channel of Object.values(channels)) {
        const levels = bands.slice(channel.from, channel.to);
        const attacks = levels.map((level, index) =>
          Math.max(0, level - (previous[channel.from + index] ?? 0)));
        const flux = average(attacks);
        // Each frequency range adapts to its own recent attacks. A quiet snare is not
        // suppressed by the bass level, and a held bass note does not keep the text enlarged.
        channel.peak = Math.max(0.015, flux, channel.peak * Math.exp(-elapsed / 1.5));
        const threshold = Math.max(0.006, channel.mean * 1.8);
        const broadband = attacks.filter((attack) => attack > 0.004).length >= levels.length * channel.coverage;
        // A snare has a body as well as its noisy top. Treble-only cymbals and hi-hats
        // must not flash the whole lyric line as if they were a snare.
        const body = average(attacks.slice(0, Math.ceil(attacks.length / 3))) > 0.004;
        channel.cooldown = Math.max(0, channel.cooldown - elapsed);
        const hit = body && broadband && flux > threshold && channel.cooldown === 0;
        const target = hit ? Math.min(1, Math.sqrt(flux / (channel.peak * 0.8))) : 0;
        if (hit) channel.cooldown = 0.075;
        channel.mean += (flux - channel.mean) * (1 - Math.exp(-elapsed / 0.4));
        channel.envelope = Math.max(target, channel.envelope * Math.exp(-elapsed / 0.045));
      }
      previous = [...bands];
      return {
        kick: channels.kick.envelope,
        snare: channels.snare.envelope,
        pulse: Math.max(channels.kick.envelope, channels.snare.envelope),
      };
    },
  };
};

export const toSpectrumFrame = (
  bands: readonly number[],
  backingBands: readonly number[] = bands,
): SpectrumFrame => {
  const bassBands = bands.slice(0, bassBandCount);
  return {
    bands,
    backingBands: backingBands.length > 0 ? backingBands : bands,
    bass:
      bassBands.length === 0
        ? 0
        : bassBands.reduce((sum, level) => sum + level, 0) / bassBands.length,
    active: bands.some((level) => level > activeThreshold),
  };
};

/**
 * Feeds the backdrop with the output spectrum measured by AudioService. One request is in flight at a time and
 * polling stops while the service is not ready or the window is hidden, so it never queues behind real commands.
 */
export const useSpectrumFeed = (
  enabled: boolean,
  onFrame: (frame: SpectrumFrame) => void,
  pollMilliseconds = 50,
): void => {
  const { audio } = store.application.services;
  const ready = audio.kind === "ready";
  const inFlight = useRef(false);

  useEffect(() => {
    if (!enabled || !ready) return;
    let stopped = false;
    let timer = 0;
    let silentFrames = 0;
    const tick = async () => {
      if (stopped) return;
      const started = performance.now();
      if (!inFlight.current) {
        inFlight.current = true;
        try {
          const { bands, backingBands } = await audioClient.spectrum();
          const frame = toSpectrumFrame(bands, backingBands);
          silentFrames = isSilent(frame) ? silentFrames + 1 : 0;
          if (!stopped) onFrame(frame);
        } catch {
          // The service health polling reports outages; the animation simply idles.
        } finally {
          inFlight.current = false;
        }
      }
      const delay =
        silentFrames > 1000 / pollMilliseconds
          ? silentPollMilliseconds
          : pollMilliseconds;
      if (!stopped) timer = window.setTimeout(
        () => void tick(), Math.max(4, delay - (performance.now() - started)),
      );
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [enabled, ready, onFrame, pollMilliseconds]);
};
