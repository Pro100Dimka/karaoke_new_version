import { LayoutGrid } from "lucide-react";
import { useText } from "../../../i18n/useText";
import { Button } from "../../../theme/ui";
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
    <ConsoleSection icon={LayoutGrid} title={t("consoleMode")}>
      <div className="presetGrid" role="group" aria-label={t("effectPresets")}>
        {effectPresets.map(preset => (
          <Button
            key={preset.id}
            size="sm"
            variant={selected === preset.id ? "contained" : "outlined"}
            aria-pressed={selected === preset.id}
            disabled={!microphoneAvailable}
            onClick={() => onSelect(preset)}
          >
            {preset.symbol} {t(preset.label)}
          </Button>
        ))}
      </div>
    </ConsoleSection>
  );
};
