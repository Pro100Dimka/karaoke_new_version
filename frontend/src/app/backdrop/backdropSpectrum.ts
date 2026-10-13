/** AudioService's output bands: 18 log-spaced Goertzel bands from 40 Hz to 12 kHz (OutputSpectrum.cpp). */
export const backdropSpectrumRange = [40, 12000] as const;

const floorDb = -60;
// Room noise and a quiet microphone stay below this; only an actual voice moves the field.
const voiceGate = 0.35;
// Where a singing voice carries its energy, as a bell over log frequency.
const voiceCenterHz = 600;
const voiceWidth = 1.1;
const silence = 0.02;

/** The microphone RMS on the spectrum's scale (dBFS from −60 to 0 → 0..1), gated against room noise. */
export const voiceLevel = (rms: number): number => {
  const level = Math.min(1, Math.max(0, (20 * Math.log10(Math.max(rms, 1e-6)) - floorDb) / -floorDb));
  return level <= voiceGate ? 0 : (level - voiceGate) / (1 - voiceGate);
};

/**
 * The output spectrum (radio, songs, monitored voice) with the microphone folded in, so the singer
 * moves the field even when monitoring is off. The louder of the two wins per band, so a monitored
 * voice is not counted twice. `undefined` for silence, which lets the scene rest.
 */
export const backdropSpectrum = (
  output: readonly number[],
  voice: number,
): number[] | undefined => {
  const count = output.length || 18;
  const [low, high] = backdropSpectrumRange;
  const bands = Array.from({ length: count }, (_, band) => {
    const hz = low * (high / low) ** (band / Math.max(1, count - 1));
    const shape = Math.exp(-(Math.log(hz / voiceCenterHz) ** 2) / (2 * voiceWidth ** 2));
    return Math.max(output[band] ?? 0, voice * shape);
  });
  return bands.some((level) => level > silence) ? bands : undefined;
};
