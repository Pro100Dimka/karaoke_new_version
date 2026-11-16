import { observeOperation } from '../../../shared/errors';
import { store } from '../../../providers/store';
import { audioClient as audio } from '../../../services/audioClient';
import { useEffect } from 'react';
import type { VoiceChainAudioPort } from '../../../application/karaoke/KaraokePorts';
import {
  noiseReduction,
  noiseThreshold,
} from '../../../application/karaoke/noiseSuppression';
import type { Preferences } from '../../../shared/preferences/preferences';
import {
  anyEffectActive,
  effectBaseParameters,
  voiceEffects,
} from './voiceEffects';

/** The singer's own voice settings: one stored value each, shown by every knob that controls it. */
type VoiceChainSettings = Pick<
  Preferences,
  'voiceGain' | 'karaokeEffects' | 'noiseSuppression'
>;
const pendingChains = new WeakMap<
  VoiceChainAudioPort,
  { tail: Promise<void>; revision: number }
>();

/**
 * Sends the singer's own microphone volume, voice effects and noise suppression to AudioService.
 * The settings, the karaoke console and the room panel only change the stored values; this is the
 * one place that applies them, so all of them always show and play the same thing.
 */
export const applyVoiceChain = (
  { voiceGain, karaokeEffects, noiseSuppression }: VoiceChainSettings,
  audioClient: VoiceChainAudioPort,
) => {
  const parameters: [string, number][] = [
    ...voiceEffects.map((effect): [string, number] => [
      effect.parameter,
      karaokeEffects[effect.id] * effect.parameterScale,
    ]),
    ['noise.threshold', noiseThreshold(noiseSuppression)],
    ['noise.reduction', noiseReduction(noiseSuppression)],
    ...Object.entries(effectBaseParameters),
  ];
  const enabled = anyEffectActive(karaokeEffects, noiseSuppression);
  const pending = pendingChains.get(audioClient) ?? {
    tail: Promise.resolve(),
    revision: 0,
  };
  pendingChains.set(audioClient, pending);
  const revision = ++pending.revision;
  pending.tail = pending.tail
    .catch(() => undefined)
    .then(async () => {
      if (pending.revision !== revision) return;
      await audioClient.setMixer('mic', voiceGain);
      if (pending.revision !== revision) return;
      const results = await Promise.allSettled(
        parameters.map(([name, value]) =>
          audioClient.setDspParameter(name, value),
        ),
      );
      const failure = results.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
      if (pending.revision === revision)
        await audioClient.setDspEnabled(enabled);
    });
  return pending.tail;
};

/** Keeps AudioService on the stored voice settings for the whole app, not only inside karaoke. */
export const useVoiceChain = (): void => {
  const { preferences } = store;
  const { voiceGain, karaokeEffects, noiseSuppression } = preferences;
  useEffect(() => {
    void observeOperation(
      'errors.voiceEffects',
      applyVoiceChain({ voiceGain, karaokeEffects, noiseSuppression }, audio),
    ).catch(() => undefined);
  }, [voiceGain, karaokeEffects, noiseSuppression]);
};
