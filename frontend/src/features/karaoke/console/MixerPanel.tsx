import { Mic } from "lucide-react";
import type { MixerChannelGains } from "../../../contracts/models";
import type { MessageKey } from "../../../i18n/messages";
import { useText } from "../../../i18n/useText";
import { RotaryKnob, Switch, Typography } from "../../../theme/ui";
import { voiceEffects, type VoiceEffectId, type VoiceEffectValues } from "./voiceEffects";

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

const channels: readonly { id: keyof MixerChannelGains; label: MessageKey; needsMicrophone: boolean }[] = [
  { id: "mic", label: "mixerMicrophone", needsMicrophone: true },
  { id: "music", label: "music", needsMicrophone: false },
  { id: "reference", label: "mixerGuide", needsMicrophone: false }
];

/** Monitoring switch and one rotary knob per voice effect and channel, alternating high and low in a zigzag. */
export const MixerPanel = ({ gains, effects, monitoring, microphoneAvailable, onGainChange, onEffectChange, onToggleMonitoring }: MixerPanelProps) => {
  const t = useText();
  const effectKnobs: Knob[] = voiceEffects.map(effect => ({
    ...effect,
    disabled: !microphoneAvailable,
    value: effects[effect.id],
    onChange: value => onEffectChange(effect.id, value)
  }));
  const channelKnobs: Knob[] = channels.map(channel => ({
    id: channel.id,
    label: channel.label,
    min: 0,
    max: 1,
    step: 0.01,
    initial: 1,
    disabled: channel.needsMicrophone && !microphoneAvailable,
    value: gains[channel.id],
    onChange: value => onGainChange(channel.id, value)
  }));
  const knobs = effectKnobs.flatMap((effect, index) => (channelKnobs[index] ? [effect, channelKnobs[index]] : [effect]));

  return (
    <div className="mixerPanel" role="group" aria-label={t("mixer")}>
      <div className="mixerHeader">
        <Mic aria-hidden />
        <Typography variant="caption">
          <strong>{t("mixer")}</strong>
        </Typography>
        <Switch size="sm" variant="plain" label={t("monitoring")} checked={monitoring} disabled={!microphoneAvailable} onChange={onToggleMonitoring} />
      </div>
      <div className="mixerKnobs">
        {knobs.map(knob => (
          <RotaryKnob
            key={knob.id}
            label={t(knob.label)}
            size="sm"
            min={knob.min}
            max={knob.max}
            step={knob.step}
            defaultValue={knob.initial}
            displayFactor={100}
            accent={knob.accent}
            disabled={knob.disabled}
            value={knob.value}
            onChange={knob.onChange}
          />
        ))}
      </div>
    </div>
  );
};
