import { Headphones, Mic, Music } from "lucide-react";
import type { MixerChannelGains } from "../../../contracts/models";
import type { MessageKey } from "../../../i18n/messages";
import { useText } from "../../../i18n/useText";
import { RotaryKnob } from "../../../theme/ui";
import { ConsoleSection } from "./ConsoleSection";
import {
  voiceEffects,
  type VoiceEffectId,
  type VoiceEffectValues,
} from "./voiceEffects";

interface Knob {
  id: string;
  label: MessageKey;
  min: number;
  max: number;
  step: number;
  initial: number;
  accent?: "secondary";
  disabled: boolean;
  value: number;
  onChange(value: number): void;
}

interface MixerPanelProps {
  gains: MixerChannelGains;
  effects: VoiceEffectValues;
  monitoring: boolean;
  microphoneAvailable: boolean;
  onGainChange(channel: keyof MixerChannelGains, value: number): void;
  onEffectChange(id: VoiceEffectId, value: number): void;
  onToggleMonitoring(): void;
}

const channels: readonly {
  id: keyof MixerChannelGains;
  label: MessageKey;
  needsMicrophone: boolean;
  initial: number;
}[] = [
  { id: "mic", label: "mixerMicrophone", needsMicrophone: true, initial: 1 },
  { id: "music", label: "music", needsMicrophone: false, initial: 1 },
  { id: "reference", label: "mixerGuide", needsMicrophone: false, initial: 0 },
  { id: "melody", label: "mixerMelody", needsMicrophone: false, initial: 0 },
];

/** Two console panels: the song channels, and the mixer with the microphone (it carries monitoring) and voice effects. */
export const MixerPanel = ({
  gains,
  effects,
  monitoring,
  microphoneAvailable,
  onGainChange,
  onEffectChange,
  onToggleMonitoring,
}: MixerPanelProps) => {
  const t = useText();
  const effectKnobs: Knob[] = voiceEffects.map((effect) => ({
    ...effect,
    disabled: !microphoneAvailable,
    value: effects[effect.id],
    onChange: (value) => onEffectChange(effect.id, value),
  }));
  const channelKnobs: Knob[] = channels.map((channel) => ({
    id: channel.id,
    label: channel.label,
    min: 0,
    max: 1,
    step: 0.01,
    initial: channel.initial,
    disabled: channel.needsMicrophone && !microphoneAvailable,
    value: gains[channel.id],
    onChange: (value) => onGainChange(channel.id, value),
  }));
  const knobRow = (knobs: readonly Knob[]) => (
    <div className="consoleKnobs">
      {knobs.map((knob) => (
        <RotaryKnob
          key={knob.id}
          label={t(knob.label)}
          size="xs"
          min={knob.min}
          max={knob.max}
          step={knob.step}
          defaultValue={knob.initial}
          displayFactor={100}
          accent={knob.accent}
          disabled={knob.disabled}
          value={knob.value}
          onChange={knob.onChange}
          btnProps={
            knob.id === "mic"
              ? {
                  icon: <Headphones aria-hidden />,
                  onClick: onToggleMonitoring,
                  tooltip: t("monitoring"),
                  disabled: !microphoneAvailable,
                  pressed: monitoring,
                }
              : undefined
          }
        />
      ))}
    </div>
  );

  return (
    <>
      <ConsoleSection icon={Music} title={t("consoleSong")}>
        {knobRow(channelKnobs.filter((knob) => knob.id !== "mic"))}
      </ConsoleSection>
      <ConsoleSection icon={Mic} title={t("mixer")}>
        {knobRow([...channelKnobs.filter((knob) => knob.id === "mic"), ...effectKnobs])}
      </ConsoleSection>
    </>
  );
};
