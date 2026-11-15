import type { MixerChannel } from '../../contracts/clients';
import { masterGainMax } from '../preferences/preferences';

// Keep the stored cubic accompaniment levels and linear voice/master gains unchanged.
// The UI converts the actual gain to a fader position; AudioService sets the song's base loudness.
const faderChannels: ReadonlySet<MixerChannel> = new Set([
  'music',
  'reference',
  'melody',
]);
const maximumGain: Partial<Record<MixerChannel, number>> = {
  mic: 4,
  master: masterGainMax,
};

/** A 60 dB fader, with exact silence at zero and the existing maximum at one. */
export const volumeFromKnob = (position: number, maximum = 1): number =>
  position <= 0 ? 0 : maximum * 10 ** ((Math.min(1, position) - 1) * 3);

export const volumeToKnob = (gain: number, maximum = 1): number =>
  gain <= 0 ? 0 : Math.max(0, Math.min(1, 1 + Math.log10(gain / maximum) / 3));

/** Convert stored channel levels to native gain, independently of the visible knob scale. */
export const mixerGain = (channel: MixerChannel, position: number): number => {
  const clamped = Math.min(maximumGain[channel] ?? 1, Math.max(0, position));
  return faderChannels.has(channel) ? clamped ** 3 : clamped;
};
