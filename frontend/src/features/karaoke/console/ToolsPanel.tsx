import { AudioLines, MousePointer2, Type, type LucideIcon } from "lucide-react";
import type { MessageKey } from "../../../i18n/messages";
import { useText } from "../../../i18n/useText";
import { Button } from "../../../theme/ui";
import { effectPresets, type EffectPreset } from "./voiceEffects";

interface Tool {
  id: string;
  label: MessageKey;
  icon: LucideIcon;
  active: boolean;
  disabled: boolean;
  onToggle(): void;
}

interface ToolsPanelProps {
  showNotes: boolean;
  showLyrics: boolean;
  autoHide: boolean;
  hasNotes: boolean;
  hasLyrics: boolean;
  microphoneAvailable: boolean;
  effectPreset: string | null;
  onEffectPreset(preset: EffectPreset): void;
  onShowNotes(value: boolean): void;
  onShowLyrics(value: boolean): void;
  onAutoHide(value: boolean): void;
}

/** Independent switches for the piano roll, the lyrics and console auto-hide, then the reverb presets. */
export const ToolsPanel = ({ showNotes, showLyrics, autoHide, hasNotes, hasLyrics, microphoneAvailable, effectPreset, onEffectPreset, onShowNotes, onShowLyrics, onAutoHide }: ToolsPanelProps) => {
  const t = useText();
  const tools: readonly Tool[] = [
    { id: "notes", label: "toolNotes", icon: AudioLines, active: showNotes, disabled: !hasNotes, onToggle: () => onShowNotes(!showNotes) },
    { id: "lyrics", label: "toolText", icon: Type, active: showLyrics, disabled: !hasLyrics, onToggle: () => onShowLyrics(!showLyrics) },
    { id: "autohide", label: "toolAutoHide", icon: MousePointer2, active: autoHide, disabled: false, onToggle: () => onAutoHide(!autoHide) }
  ];

  return (
    <div className="toolsPanel" role="toolbar" aria-label={t("tools")}>
      <div className="toolsModes" role="group" aria-label={t("stageLayers")}>
        {tools.map(({ id, label, icon: Icon, active, disabled, onToggle }) => (
          <Button key={id} size="sm" variant={active ? "contained" : "outlined"} tone={active ? "success" : "primary"} startIcon={<Icon />} aria-pressed={active} disabled={disabled} onClick={onToggle}>
            {t(label)}
          </Button>
        ))}
      </div>
      <div className="toolsPresets" role="group" aria-label={t("effectPresets")}>
        {effectPresets.map(preset => (
          <Button
            key={preset.id}
            size="sm"
            variant={effectPreset === preset.id ? "contained" : "outlined"}
            aria-pressed={effectPreset === preset.id}
            disabled={!microphoneAvailable}
            onClick={() => onEffectPreset(preset)}
          >
            {preset.symbol} {t(preset.label)}
          </Button>
        ))}
      </div>
    </div>
  );
};
