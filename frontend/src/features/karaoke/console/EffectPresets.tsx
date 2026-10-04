import { ToggleButton } from "@ad-voice/ui";
import { useText } from "../../../i18n/useText";
import { ConsoleSection } from "./ConsoleSection";
import { effectPresets, type EffectPreset } from "./voiceEffects";

interface EffectPresetsProps {
  selected: string | null;
  microphoneAvailable: boolean;
  onSelect(preset: EffectPreset): void;
}

/** The "Mode" panel: one button per voice effect preset. */
export const EffectPresets = ({ selected, microphoneAvailable, onSelect }: EffectPresetsProps) => {
  const t = useText();
  return (
    <ConsoleSection icon="grid" title={t("consoleMode")}>
      <div className="presetGrid" role="group" aria-label={t("effectPresets")}>
        {effectPresets.map(preset => (
          <ToggleButton key={preset.id} size="sm" checked={selected === preset.id} disabled={!microphoneAvailable}
            onValueChange={() => onSelect(preset)}>
            {preset.symbol} {t(preset.label)}
          </ToggleButton>
        ))}
      </div>
    </ConsoleSection>
  );
};
