import { useEffect } from "react";
import { useApp } from "../../../app/AppContext";
import { audioClient } from "../../../services/audioClient";
import { noiseReduction, noiseThreshold } from "../../../services/noiseSuppression";
import type { Preferences } from "../../../shared/preferences/preferences";
import { anyEffectActive, effectBaseParameters, voiceEffects } from "./voiceEffects";

/** The singer's own voice settings: one stored value each, shown by every knob that controls it. */
export type VoiceChainSettings = Pick<Preferences, "voiceGain" | "karaokeEffects" | "noiseSuppression">;

/**
 * Sends the singer's own microphone volume, voice effects and noise suppression to AudioService.
 * The settings, the karaoke console and the room panel only change the stored values; this is the
 * one place that applies them, so all of them always show and play the same thing.
 */
export const applyVoiceChain = async ({ voiceGain, karaokeEffects, noiseSuppression }: VoiceChainSettings) => {
  const parameters: [string, number][] = [
    ...voiceEffects.map((effect): [string, number] => [effect.parameter, karaokeEffects[effect.id] * effect.parameterScale]),
    ["noise.threshold", noiseThreshold(noiseSuppression)],
    ["noise.reduction", noiseReduction(noiseSuppression)],
    ...Object.entries(effectBaseParameters),
  ];
  await audioClient.setMixer("mic", voiceGain);
  await Promise.all(parameters.map(([name, value]) => audioClient.setDspParameter(name, value)));
  await audioClient.setDspEnabled(anyEffectActive(karaokeEffects, noiseSuppression));
};

/** Keeps AudioService on the stored voice settings for the whole app, not only inside karaoke. */
export const useVoiceChain = (): void => {
  const { preferences } = useApp();
  const { voiceGain, karaokeEffects, noiseSuppression } = preferences;
  useEffect(() => {
    void applyVoiceChain({ voiceGain, karaokeEffects, noiseSuppression }).catch(() => undefined);
  }, [voiceGain, karaokeEffects, noiseSuppression]);
};
