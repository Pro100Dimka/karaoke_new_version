export type VoiceEffectId = 'echo' | 'reverb' | 'delay' | 'autoTune';

/** Keep stored DSP amounts and presets intact while spreading audible changes over the knob. */
export const effectFromKnob = (position: number): number => position ** 3;
export const effectToKnob = (amount: number): number => Math.cbrt(amount);

interface VoiceEffect {
  id: VoiceEffectId;
  label: string;
  /** AudioService DSP parameter the knob drives. */
  parameter: string;
  /** AudioService receives the knob value times this scale. */
  parameterScale: number;
  min: number;
  max: number;
  step: number;
  initial: number;
  accent?: 'secondary';
}

export const voiceEffects: readonly VoiceEffect[] = [
  {
    id: 'echo',
    label: 'effectEcho',
    parameter: 'echo.amount',
    parameterScale: 1,
    min: 0,
    max: 1,
    step: 0.01,
    initial: 0,
  },
  {
    id: 'reverb',
    label: 'effectReverb',
    parameter: 'reverb.mix',
    parameterScale: 1,
    min: 0,
    max: 1,
    step: 0.01,
    initial: 0,
    accent: 'secondary',
  },
  {
    id: 'delay',
    label: 'effectDelay',
    parameter: 'delay.mix',
    parameterScale: 0.55,
    min: 0,
    max: 1,
    step: 0.01,
    initial: 0,
  },
  {
    id: 'autoTune',
    label: 'effectAutoTune',
    parameter: 'autotune.amount',
    parameterScale: 1,
    min: 0,
    max: 1,
    step: 0.01,
    initial: 0,
    accent: 'secondary',
  },
];

/** Fixed decay and repeat timing; the knobs control each effect's amount. */
export const effectBaseParameters: Readonly<Record<string, number>> = {
  'reverb.decay': 0.7,
  'delay.feedback': 0.35,
  'delay.ms': 320,
};

export type VoiceEffectValues = Record<VoiceEffectId, number>;
export const anyEffectActive = (
  values: VoiceEffectValues,
  noise: number,
): boolean =>
  noise > 0 || voiceEffects.some((effect) => values[effect.id] !== 0);

export interface EffectPreset {
  id: string;
  label: string;
  symbol: string;
  echo: number;
  reverb: number;
  delay: number;
}

export const effectPresets: readonly EffectPreset[] = [
  {
    id: 'classic',
    label: 'presetClassic',
    symbol: '♬',
    echo: 0.08,
    reverb: 0.18,
    delay: 0.12,
  },
  {
    id: 'hall',
    label: 'presetHall',
    symbol: '⌗',
    echo: 0.1,
    reverb: 0.28,
    delay: 0.16,
  },
  {
    id: 'room',
    label: 'presetRoom',
    symbol: '◇',
    echo: 0.06,
    reverb: 0.14,
    delay: 0.08,
  },
  {
    id: 'plate',
    label: 'presetPlate',
    symbol: '◉',
    echo: 0.04,
    reverb: 0.22,
    delay: 0.05,
  },
  {
    id: 'studio',
    label: 'presetStudio',
    symbol: '◌',
    echo: 0.03,
    reverb: 0.1,
    delay: 0.03,
  },
  {
    id: 'pop',
    label: 'presetPop',
    symbol: '☆',
    echo: 0.1,
    reverb: 0.16,
    delay: 0.1,
  },
  {
    id: 'rock',
    label: 'presetRock',
    symbol: 'ϟ',
    echo: 0.06,
    reverb: 0.12,
    delay: 0.07,
  },
  {
    id: 'club',
    label: 'presetClub',
    symbol: '◎',
    echo: 0.14,
    reverb: 0.24,
    delay: 0.22,
  },
];
