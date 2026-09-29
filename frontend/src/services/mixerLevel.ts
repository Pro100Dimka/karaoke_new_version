import type { MixerChannel } from "../contracts/clients";

// Karaoke backing tracks are mastered far louder than a sung voice, so the music channel tops out
// 6 dB below full scale: at 100% it no longer buries the singers.
const musicHeadroom = 0.5;

/**
 * Linear gain for a mixer knob position (0..1). Hearing is logarithmic, so the knobs follow a
 * fader law: equal turns are equal loudness steps. 100% is unity, 50% about -18 dB, 0 is silence.
 * A linear knob stayed loud over most of its travel and only fell quiet right next to zero.
 */
export const mixerGain = (channel: MixerChannel, position: number): number => {
  const clamped = Math.min(1, Math.max(0, position));
  if (channel === "master") return clamped;
  return clamped ** 3 * (channel === "music" ? musicHeadroom : 1);
};
