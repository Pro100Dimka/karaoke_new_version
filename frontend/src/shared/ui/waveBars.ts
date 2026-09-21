export const waveHeight = 48;
export const waveBarWidth = 3;
const midline = waveHeight / 2;
const minimumHalfHeight = 1.2;
const placeholderBars = 160;

/** A deterministic, gently uneven set of bars shown while real peaks are not available. */
export const placeholderPeaks = (count = placeholderBars): number[] =>
  Array.from({ length: count }, (_, index) => 0.14 + Math.abs(Math.sin(index * 1.71) + Math.sin(index * 0.37)) * 0.16);

/** One vertical stroke per peak (0..1), centred on the wave's midline; drawn as a single SVG path. */
export const barsPath = (peaks: readonly number[]): string =>
  peaks
    .map((peak, index) => {
      const half = minimumHalfHeight + peak * (midline - minimumHalfHeight - 1);
      return `M${(index * waveBarWidth).toFixed(2)} ${(midline - half).toFixed(2)}v${(half * 2).toFixed(2)}`;
    })
    .join("");
