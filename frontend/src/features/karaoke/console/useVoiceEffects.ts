import { useCallback, useEffect, useRef, useState } from "react";
import { audioClient } from "../../../services/audioClient";
import { anyEffectActive, effectBaseParameters, initialEffectValues, noiseThresholdScale, voiceEffects, type EffectPreset, type VoiceEffectId, type VoiceEffectValues } from "./voiceEffects";

/** Turning the delay time up while no echo is heard would seem broken, so the echo level starts at this value then. */
const delayEchoLevel = 0.3;

/**
 * Live voice effects: each knob drives one AudioService DSP parameter, and the noise suppression from the program settings
 * is applied as well. Every change (and every monitoring switch) sends the complete state, so AudioService always matches
 * the knobs even after its session was restarted; the chain is switched off when the screen closes.
 */
export const useVoiceEffects = (noise: number, sessionReady: boolean, monitoring: boolean) => {
  const [values, setValues] = useState<VoiceEffectValues>(initialEffectValues);
  const [preset, setPreset] = useState<string | null>(null);
  const current = useRef(values);
  const noiseLevel = useRef(noise);
  const active = useRef(false);

  const pushAll = useCallback(async () => {
    const enabled = anyEffectActive(current.current, noiseLevel.current);
    active.current = enabled;
    const parameters: [string, number][] = [
      ...voiceEffects.map((effect): [string, number] => [effect.parameter, current.current[effect.id] * effect.parameterScale]),
      ["noise.threshold", noiseLevel.current * noiseThresholdScale],
      ...Object.entries(effectBaseParameters)
    ];
    await Promise.all(parameters.map(([name, value]) => audioClient.setDspParameter(name, value).catch(() => undefined)));
    await audioClient.setDspEnabled(enabled).catch(() => undefined);
  }, []);

  const apply = useCallback(
    async (changes: Partial<VoiceEffectValues>) => {
      current.current = { ...current.current, ...changes };
      setValues(current.current);
      await pushAll();
    },
    [pushAll]
  );

  const change = useCallback(
    (id: VoiceEffectId, value: number) => {
      setPreset(null);
      const echoSilent = current.current.echo === 0;
      return apply(id === "delay" && value > 0 && echoSilent ? { delay: value, echo: delayEchoLevel } : { [id]: value });
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
    if (sessionReady) void pushAll();
  }, [noise, sessionReady, monitoring, pushAll]);

  useEffect(
    () => () => {
      if (active.current) void audioClient.setDspEnabled(false).catch(() => undefined);
    },
    []
  );

  return { values, preset, change, applyPreset };
};
