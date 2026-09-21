import type { MessageKey } from "../../../i18n/messages";

export type VoiceEffectId = "echo" | "reverb" | "delay" | "noise" | "octave";

export interface VoiceEffect {
  id: VoiceEffectId;
  label: MessageKey;
  /** AudioService DSP parameter the knob drives. */
  parameter: string;
  /** AudioService receives the knob value times this scale. */
  parameterScale: number;
  min: number;
  max: number;
  step: number;
  initial: number;
  accent?: "secondary";
  /** Delay time alone is inaudible, so only the other effects decide whether the DSP chain is needed. */
  audible: boolean;
}

export const voiceEffects: readonly VoiceEffect[] = [
  { id: "echo", label: "effectEcho", parameter: "delay.mix", parameterScale: 1, min: 0, max: 1, step: 0.01, initial: 0, audible: true },
  { id: "reverb", label: "effectReverb", parameter: "reverb.mix", parameterScale: 1, min: 0, max: 1, step: 0.01, initial: 0, accent: "secondary", audible: true },
  { id: "delay", label: "effectDelay", parameter: "delay.ms", parameterScale: 500, min: 0, max: 1, step: 0.01, initial: 0.24, audible: false },
  { id: "noise", label: "effectNoise", parameter: "noise.threshold", parameterScale: 0.25, min: 0, max: 1, step: 0.01, initial: 0, audible: true },
  { id: "octave", label: "effectOctave", parameter: "pitch.semitones", parameterScale: 12, min: -1, max: 1, step: 0.1, initial: 0, accent: "secondary", audible: true }
];

export type VoiceEffectValues = Record<VoiceEffectId, number>;

export const initialEffectValues = Object.fromEntries(voiceEffects.map(effect => [effect.id, effect.initial])) as VoiceEffectValues;

export const anyEffectActive = (values: VoiceEffectValues): boolean => voiceEffects.some(effect => effect.audible && values[effect.id] !== 0);

export interface EffectPreset {
  id: string;
  label: MessageKey;
  symbol: string;
  echo: number;
  reverb: number;
  delay: number;
}

export const effectPresets: readonly EffectPreset[] = [
  { id: "classic", label: "presetClassic", symbol: "♬", echo: 0.18, reverb: 0.64, delay: 0.12 },
  { id: "hall", label: "presetHall", symbol: "⌗", echo: 0.22, reverb: 0.72, delay: 0.16 },
  { id: "room", label: "presetRoom", symbol: "◇", echo: 0.12, reverb: 0.42, delay: 0.08 },
  { id: "plate", label: "presetPlate", symbol: "◉", echo: 0.08, reverb: 0.58, delay: 0.05 },
  { id: "studio", label: "presetStudio", symbol: "◌", echo: 0.06, reverb: 0.28, delay: 0.03 },
  { id: "pop", label: "presetPop", symbol: "☆", echo: 0.24, reverb: 0.36, delay: 0.1 },
  { id: "rock", label: "presetRock", symbol: "ϟ", echo: 0.12, reverb: 0.3, delay: 0.07 },
  { id: "club", label: "presetClub", symbol: "◎", echo: 0.38, reverb: 0.5, delay: 0.22 }
];
