import { createPortal } from "react-dom";
import { titleBarLeadingId } from "../../app/TitleBar";
import { useText } from "../../i18n/useText";
import { IconButton } from "@ad-voice/ui";

interface KaraokeHeaderProps {
  /** The buttons fade out while the pointer is idle during playback. */
  visible: boolean;
  /** Manual console toggle; only offered while auto-hide is off. */
  consoleToggle: { visible: boolean; onToggle(): void } | null;
  onBack(): void;
}

export const KaraokeHeader = ({
  visible,
  consoleToggle,
  onBack,
}: KaraokeHeaderProps) => {
  const t = useText();

  const header = (
    <header className="karaokeTop" data-hidden={!visible || undefined}>
      <div className="karaokeNav">
        <IconButton
          round
          icon="back"
          size="lg"
          label={t("library")}
          onClick={onBack}
        />
        {consoleToggle && (
          <IconButton
            round
            size="lg"
            icon={consoleToggle.visible ? "down" : "up"}
            label={t(consoleToggle.visible ? "hideConsole" : "showConsole")}
            onClick={consoleToggle.onToggle}
          />
        )}
      </div>
    </header>
  );
  const slot = document.getElementById(titleBarLeadingId);
  return slot ? createPortal(header, slot) : header;
};
