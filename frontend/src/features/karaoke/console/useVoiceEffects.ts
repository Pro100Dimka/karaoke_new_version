import { useCallback, useEffect, useRef, useState } from "react";
import { audioClient } from "../../../services/audioClient";
import { anyEffectActive, initialEffectValues, voiceEffects, type EffectPreset, type VoiceEffectId, type VoiceEffectValues } from "./voiceEffects";

/** Live voice effects: each knob drives one AudioService DSP parameter; the chain is on only while an effect is audible. */
export const useVoiceEffects = () => {
  const [values, setValues] = useState<VoiceEffectValues>(initialEffectValues);
  const [preset, setPreset] = useState<string | null>(null);
  const current = useRef(values);
  const active = useRef(false);

  const apply = useCallback(async (changes: Partial<VoiceEffectValues>) => {
    const next = { ...current.current, ...changes };
    current.current = next;
    setValues(next);
    const updates = voiceEffects.filter(effect => effect.id in changes);
    await Promise.all(updates.map(effect => audioClient.setDspParameter(effect.parameter, next[effect.id] * effect.parameterScale).catch(() => undefined)));
    const enabled = anyEffectActive(next);
    if (enabled === active.current) return;
    active.current = enabled;
    await audioClient.setDspEnabled(enabled).catch(() => undefined);
  }, []);

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

  useEffect(
    () => () => {
      if (active.current) void audioClient.setDspEnabled(false).catch(() => undefined);
    },
    []
  );

  return { values, preset, change, applyPreset };
};
