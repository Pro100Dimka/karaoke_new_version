import { memo } from "react";
import { IconButton, RotaryKnob, Stack, tr, useLocale } from "@neo-ui-kit/react";
import type { MixerChannelGains } from "../../../contracts/models";
import type { MessageKey } from "../../../i18n/messages";
import { ru } from "../../../i18n/messages.ru";
import { ConsoleSection } from "./ConsoleSection";
import { EffectPresets } from "./EffectPresets";
import { fixedKnobWidth } from "../../../shared/ui/knobWidth";
import {
  voiceEffects,
  type VoiceEffectId,
  type VoiceEffectValues,
  type EffectPreset,
} from "./voiceEffects";

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
  section: "song" | "voice";
  gains: MixerChannelGains;
  effects: VoiceEffectValues;
  monitoring: boolean;
  microphoneAvailable: boolean;
  onGainChange(channel: keyof MixerChannelGains, value: number): void;
  onEffectChange(id: VoiceEffectId, value: number): void;
  onToggleMonitoring(): void;
  selectedPreset: string | null;
  presetsOpen: boolean;
  onPresetsOpenChange(open: boolean): void;
  onPresetSelect(preset: EffectPreset): void;
}

const knobDiameter = 70;

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

/** Song channels or the microphone with monitoring, effects and presets. */
export const MixerPanel = memo(({
  section,
  gains,
  effects,
  monitoring,
  microphoneAvailable,
  onGainChange,
  onEffectChange,
  onToggleMonitoring,
  selectedPreset,
  presetsOpen,
  onPresetsOpenChange,
  onPresetSelect,
}: MixerPanelProps) => {
  useLocale();
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
    max: channel.needsMicrophone ? 4 : 1,
    step: 0.01,
    initial: channel.initial,
    disabled: channel.needsMicrophone && !microphoneAvailable,
    value: gains[channel.id],
    onChange: (value) => onGainChange(channel.id, value),
  }));
  const knob = (item: Knob) => (
    <RotaryKnob
      data-knob={item.id}
      style={fixedKnobWidth(knobDiameter)}
      showLabel
      label={tr(ru[item.label])}
      min={item.min}
      max={item.max}
      step={item.step}
      diameter={knobDiameter}
      displayScale={100}
      resetValue={item.initial}
      disabled={item.disabled}
      value={item.value}
      onValueChange={item.onChange}
    />
  );
  const panel = ({
    song: {
      icon: "music", title: "consoleSong",
      knobs: channelKnobs.filter((item) => item.id !== "mic"),
    },
    voice: {
      icon: "mic", title: "mixer",
      knobs: [...channelKnobs.filter((item) => item.id === "mic"), ...effectKnobs],
    },
  } as const)[section];

  return (
    <ConsoleSection icon={panel.icon} title={tr(ru[panel.title])}>
      <Stack className={`consoleKnobs consoleKnobs-${section}`} direction="row" gap={2} justify="center" align="center">
        {panel.knobs.map((item) => (
          <div key={item.id} className="consoleKnob" data-channel={item.id}>
            {knob(item)}
            {item.id === "mic" && (
              <IconButton
                size="xs"
                round
                icon="mic"
                label={tr(ru.monitoring)}
                aria-pressed={monitoring}
                variant={monitoring ? "primary" : "secondary"}
                disabled={!microphoneAvailable}
                onClick={onToggleMonitoring}
              />
            )}
          </div>
        ))}
      </Stack>
      {section === "voice" && (
        <EffectPresets
          selected={selectedPreset}
          open={presetsOpen}
          onOpenChange={onPresetsOpenChange}
          microphoneAvailable={microphoneAvailable}
          onSelect={onPresetSelect}
        />
      )}
    </ConsoleSection>
  );
});
