import { ToggleButton } from "@ad-voice/ui";
import type { MessageKey } from "../../../i18n/messages";
import { useText } from "../../../i18n/useText";

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
  const toggles: readonly { id: string; label: MessageKey; icon: string; active: boolean; disabled: boolean; set(value: boolean): void }[] = [
    { id: "notes", label: "toolNotes", icon: "wave", active: showNotes, disabled: !hasNotes, set: onShowNotes },
    { id: "lyrics", label: "toolText", icon: "document", active: showLyrics, disabled: !hasLyrics, set: onShowLyrics },
    { id: "autohide", label: "toolAutoHide", icon: "cursor", active: autoHide, disabled: false, set: onAutoHide },
  ];
  return (
    <div className="displayToggles" role="group" aria-label={t("stageLayers")}>
      {toggles.map(toggle => (
        <ToggleButton key={toggle.id} size="sm" icon={toggle.icon} checked={toggle.active} disabled={toggle.disabled}
          onValueChange={toggle.set}>
          {t(toggle.label)}
        </ToggleButton>
      ))}
    </div>
  );
};
