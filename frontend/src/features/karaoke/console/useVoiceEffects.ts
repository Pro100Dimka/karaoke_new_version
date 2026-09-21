import { useCallback, useEffect, useRef, useState } from "react";
import { audioClient } from "../../../services/audioClient";
import { anyEffectActive, effectBaseParameters, initialEffectValues, noiseThresholdScale, voiceEffects, type EffectPreset, type VoiceEffectId, type VoiceEffectValues } from "./voiceEffects";

/**
 * Live voice effects: each knob drives one AudioService DSP parameter, and the noise suppression from the program settings
 * is applied as well. The chain is on only while something is audible, and it is switched off when the screen closes.
 */
export const useVoiceEffects = (noise: number, sessionReady: boolean) => {
  const [values, setValues] = useState<VoiceEffectValues>(initialEffectValues);
  const [preset, setPreset] = useState<string | null>(null);
  const current = useRef(values);
  const noiseLevel = useRef(noise);
  const active = useRef(false);

  const syncChain = useCallback(async () => {
    const enabled = anyEffectActive(current.current, noiseLevel.current);
    if (enabled === active.current) return;
    active.current = enabled;
    if (enabled) await Promise.all(Object.entries(effectBaseParameters).map(([name, value]) => audioClient.setDspParameter(name, value).catch(() => undefined)));
    await audioClient.setDspEnabled(enabled).catch(() => undefined);
  }, []);

  const apply = useCallback(
    async (changes: Partial<VoiceEffectValues>) => {
      const next = { ...current.current, ...changes };
      current.current = next;
      setValues(next);
      const updates = voiceEffects.filter(effect => effect.id in changes);
      await Promise.all(updates.map(effect => audioClient.setDspParameter(effect.parameter, next[effect.id] * effect.parameterScale).catch(() => undefined)));
      await syncChain();
    },
    [syncChain]
  );

  const change = useCallback(
    (id: VoiceEffectId, value: number) => {
      setPreset(null);
      return apply({ [id]: value });
    },
    [apply]
  );

  const applyPreset = useCallback(
    (item: EffectPreset) => {
      setPreset(item.id);
      return apply({ echo: item.echo, reverb: item.reverb, delay: item.delay });
    },
    [apply]
  );

  useEffect(() => {
    noiseLevel.current = noise;
    if (!sessionReady) return;
    void audioClient.setDspParameter("noise.threshold", noise * noiseThresholdScale).catch(() => undefined);
    void syncChain();
  }, [noise, sessionReady, syncChain]);

  useEffect(
    () => () => {
      if (active.current) void audioClient.setDspEnabled(false).catch(() => undefined);
    },
    []
  );

  return { values, preset, change, applyPreset };
};
