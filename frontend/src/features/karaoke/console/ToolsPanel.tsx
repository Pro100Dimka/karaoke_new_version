import { AudioLines, Maximize2, Settings2, Type, type LucideIcon } from "lucide-react";
import type { MessageKey } from "../../../i18n/messages";
import { useText } from "../../../i18n/useText";
import type { KaraokeDisplayMode } from "../../../shared/preferences/preferences";
import { Button, IconButton } from "../../../theme/ui";
import type { RecordingUiState } from "../useKaraokeSession";
import { effectPresets, type EffectPreset } from "./voiceEffects";

const modeLabel = {
  lyricsPiano: "modeLyricsPiano",
  lyricsOnly: "modeLyricsOnly",
  lyricsPitch: "modeLyricsPitch",
  minimal: "modeMinimal"
} as const satisfies Record<KaraokeDisplayMode, MessageKey>;

const modeIcon = {
  lyricsPiano: AudioLines,
  lyricsOnly: Type,
  lyricsPitch: AudioLines,
  minimal: Type
} as const satisfies Record<KaraokeDisplayMode, LucideIcon>;

const recordingLabel = {
  idle: "recording",
  starting: "recordingStarting",
  recording: "recordingActive",
  stopping: "recordingFinalizing",
  failed: "recordingFailed"
} as const satisfies Record<RecordingUiState, MessageKey>;

interface ToolsPanelProps {
  displayMode: KaraokeDisplayMode;
  availableModes: readonly KaraokeDisplayMode[];
  recording: RecordingUiState;
  microphoneAvailable: boolean;
  effectPreset: string | null;
  onEffectPreset(preset: EffectPreset): void;
  onDisplayMode(mode: KaraokeDisplayMode): void;
  onToggleRecording(): void;
  onFullscreen(): void;
  onOpenSettings(): void;
}

/** Display-mode buttons (the active one filled), recording, fullscreen and settings. */
export const ToolsPanel = ({ displayMode, availableModes, recording, microphoneAvailable, effectPreset, onEffectPreset, onDisplayMode, onToggleRecording, onFullscreen, onOpenSettings }: ToolsPanelProps) => {
  const t = useText();
  const busy = recording === "starting" || recording === "stopping";
  const recordingNow = recording === "recording";

  return (
    <div className="toolsPanel" role="toolbar" aria-label={t("tools")}>
      <div className="toolsModes" role="group" aria-label={t("displayMode")}>
        {availableModes.map(mode => {
          const Icon = modeIcon[mode];
          const active = mode === displayMode;
          return (
            <Button key={mode} size="sm" variant={active ? "contained" : "outlined"} tone={active ? "success" : "primary"} startIcon={<Icon />} aria-pressed={active} onClick={() => onDisplayMode(mode)}>
              {t(modeLabel[mode])}
            </Button>
          );
        })}
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
      <div className="toolsActions">
        <Button
          variant={recordingNow ? "contained" : "outlined"}
          tone={recordingNow ? "danger" : "primary"}
          startIcon={<span className="recordDot" aria-hidden />}
          aria-pressed={recordingNow}
          disabled={!microphoneAvailable || busy}
          onClick={onToggleRecording}
        >
          {t(recordingLabel[recording])}
        </Button>
        <IconButton icon={Maximize2} label={t("fullscreen")} variant="outline" onClick={onFullscreen} />
        <Button variant="outlined" tone="neutral" startIcon={<Settings2 />} onClick={onOpenSettings}>
          {t("settings")}
        </Button>
      </div>
    </div>
  );
};
