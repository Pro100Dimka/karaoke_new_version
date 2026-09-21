import { ArrowLeft, PanelBottomClose, PanelBottomOpen } from "lucide-react";
import { useText } from "../../i18n/useText";
import { IconButton } from "../../theme/ui";

interface KaraokeHeaderProps {
  /** The buttons fade out while the pointer is idle during playback. */
  visible: boolean;
  /** Manual console toggle; only offered while auto-hide is off. */
  consoleToggle: { visible: boolean; onToggle(): void } | null;
  onBack(): void;
}

export const KaraokeHeader = ({ visible, consoleToggle, onBack }: KaraokeHeaderProps) => {
  const t = useText();

  return (
    <header className="karaokeTop" data-hidden={!visible || undefined}>
      <div className="karaokeNav">
        <IconButton icon={ArrowLeft} size="lg" label={t("library")} variant="outline" onClick={onBack} />
        {consoleToggle && (
          <IconButton
            size="lg"
            icon={consoleToggle.visible ? PanelBottomClose : PanelBottomOpen}
            label={t(consoleToggle.visible ? "hideConsole" : "showConsole")}
            variant="outline"
            onClick={consoleToggle.onToggle}
          />
        )}
      </div>
    </header>
  );
};
