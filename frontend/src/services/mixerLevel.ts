import type { MixerChannel } from '../contracts/clients';
import { masterGainMax } from '../shared/preferences/preferences';

// The accompaniment knobs follow a fader law; voices (the microphone, remote participants) and the
// master keep their linear knobs, so a saved voice level sounds exactly as it always did. How loud a
// song is at 100% is measured by AudioService (streaming loudness), not fixed here.
const faderChannels: ReadonlySet<MixerChannel> = new Set([
  'music',
  'reference',
  'melody',
]);
const maximumGain: Partial<Record<MixerChannel, number>> = { mic: 4, master: masterGainMax };

/**
 * Linear gain for microphone 0..4, master 0..1.5 and accompaniment 0..1. Hearing is logarithmic, so the accompaniment knobs
 * follow a fader law: equal turns are equal loudness steps. 100% is unity, 50% about -18 dB, 0 is
 * silence. A linear music knob stayed loud over most of its travel and only fell quiet next to zero.
 */
export const mixerGain = (channel: MixerChannel, position: number): number => {
  const clamped = Math.min(maximumGain[channel] ?? 1, Math.max(0, position));
  return faderChannels.has(channel) ? clamped ** 3 : clamped;
};
