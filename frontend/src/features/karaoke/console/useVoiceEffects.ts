import { useCallback, useState } from "react";
import type { EffectPreset, VoiceEffectId, VoiceEffectValues } from "./voiceEffects";

/**
 * The karaoke voice-effect knobs and presets. The values are the singer's stored ones, the same the
 * room panel shows; changing them only stores them, and the app-wide voice chain (see voiceChain)
 * applies them to AudioService.
 */
export const useVoiceEffects = (
  values: VoiceEffectValues,
  onValuesChange: (values: VoiceEffectValues) => void,
) => {
  const [preset, setPreset] = useState<string | null>(null);

  const change = useCallback(
    (id: VoiceEffectId, value: number) => {
      setPreset(null);
      onValuesChange({ ...values, [id]: value });
    },
    [onValuesChange, values]
  );

  const applyPreset = useCallback(
    (item: EffectPreset) => {
      setPreset(item.id);
      onValuesChange({ ...values, echo: item.echo, reverb: item.reverb, delay: item.delay });
    },
    [onValuesChange, values]
  );

  return { values, preset, change, applyPreset };
};
