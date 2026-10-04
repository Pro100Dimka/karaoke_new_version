import { IconButton, RotaryKnob } from "@ad-voice/ui";
import type { MixerChannelGains } from "../../../contracts/models";
import type { MessageKey } from "../../../i18n/messages";
import { useText } from "../../../i18n/useText";
import { ConsoleSection } from "./ConsoleSection";
import { voiceEffects, type VoiceEffectId, type VoiceEffectValues } from "./voiceEffects";

interface Knob {
  id: string;
  label: MessageKey;
  min: number;
  max: number;
  step: number;
  initial: number;
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

const channels: readonly { id: keyof MixerChannelGains; label: MessageKey; needsMicrophone: boolean; initial: number }[] = [
  { id: "mic", label: "mixerMicrophone", needsMicrophone: true, initial: 1 },
  { id: "music", label: "music", needsMicrophone: false, initial: 1 },
  { id: "reference", label: "mixerGuide", needsMicrophone: false, initial: 0 },
  { id: "melody", label: "mixerMelody", needsMicrophone: false, initial: 0 },
];

/** Two console panels: the song channels, and the mixer with the microphone (it carries monitoring) and voice effects. */
export const MixerPanel = ({ gains, effects, monitoring, microphoneAvailable, onGainChange, onEffectChange, onToggleMonitoring }: MixerPanelProps) => {
  const t = useText();
  const effectKnobs: Knob[] = voiceEffects.map(effect => ({
    ...effect,
    disabled: !microphoneAvailable,
    value: effects[effect.id],
    onChange: value => onEffectChange(effect.id, value),
  }));
  const channelKnobs: Knob[] = channels.map(channel => ({
    id: channel.id,
    label: channel.label,
    min: 0,
    max: 1,
    step: 0.01,
    initial: channel.initial,
    disabled: channel.needsMicrophone && !microphoneAvailable,
    value: gains[channel.id],
    onChange: value => onGainChange(channel.id, value),
  }));
  const knob = (item: Knob) => (
    <RotaryKnob key={item.id} diameter={50} showLabel label={t(item.label)} min={item.min} max={item.max} step={item.step}
      displayScale={100} resetValue={item.initial} disabled={item.disabled} value={item.value} onValueChange={item.onChange} />
  );
  const microphone = channelKnobs.find(item => item.id === "mic");

  return (
    <>
      <ConsoleSection icon="music" title={t("consoleSong")}>
        <div className="consoleKnobs">{channelKnobs.filter(item => item.id !== "mic").map(knob)}</div>
      </ConsoleSection>
      <ConsoleSection icon="mic" title={t("mixer")}>
        <div className="consoleKnobs">
          {microphone && (
            <div className="consoleMicrophone">
              {knob(microphone)}
              <IconButton size="xs" round icon="headphones" label={t("monitoring")} aria-pressed={monitoring}
                variant={monitoring ? "primary" : "secondary"} disabled={!microphoneAvailable} onClick={onToggleMonitoring} />
            </div>
          )}
          {effectKnobs.map(knob)}
        </div>
      </ConsoleSection>
    </>
  );
};
