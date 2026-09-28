import { AudioLines, MousePointer2, Type, type LucideIcon } from "lucide-react";
import type { MessageKey } from "../../../i18n/messages";
import { useText } from "../../../i18n/useText";
import { Button } from "../../../theme/ui";

interface Toggle {
  id: string;
  label: MessageKey;
  icon: LucideIcon;
  active: boolean;
  disabled: boolean;
  onToggle(): void;
}

interface DisplayTogglesProps {
  showNotes: boolean;
  showLyrics: boolean;
  autoHide: boolean;
  hasNotes: boolean;
  hasLyrics: boolean;
  onShowNotes(value: boolean): void;
  onShowLyrics(value: boolean): void;
  onAutoHide(value: boolean): void;
}

/** Independent switches for the piano roll, the lyrics and console auto-hide. */
export const DisplayToggles = ({ showNotes, showLyrics, autoHide, hasNotes, hasLyrics, onShowNotes, onShowLyrics, onAutoHide }: DisplayTogglesProps) => {
  const t = useText();
  const toggles: readonly Toggle[] = [
    { id: "notes", label: "toolNotes", icon: AudioLines, active: showNotes, disabled: !hasNotes, onToggle: () => onShowNotes(!showNotes) },
    { id: "lyrics", label: "toolText", icon: Type, active: showLyrics, disabled: !hasLyrics, onToggle: () => onShowLyrics(!showLyrics) },
    { id: "autohide", label: "toolAutoHide", icon: MousePointer2, active: autoHide, disabled: false, onToggle: () => onAutoHide(!autoHide) }
  ];

  return (
    <div className="displayToggles" role="group" aria-label={t("stageLayers")}>
      {toggles.map(({ id, label, icon: Icon, active, disabled, onToggle }) => (
        <Button key={id} size="sm" variant={active ? "contained" : "outlined"} startIcon={<Icon />} aria-pressed={active} disabled={disabled} onClick={onToggle}>
          {t(label)}
        </Button>
      ))}
    </div>
  );
};
