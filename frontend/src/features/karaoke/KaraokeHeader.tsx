import { createPortal } from "react-dom";
import { titleBarLeadingId } from "../../app/TitleBar";
import { ru } from "../../i18n/messages.ru";
import { IconButton, tr, useLocale } from "@neo-ui-kit/react";

interface KaraokeHeaderProps {
  /** The buttons fade out while the pointer is idle during playback. */
  visible: boolean;
  /** Manual console toggle; only offered while auto-hide is off. */
  consoleToggle: { visible: boolean; onToggle(): void } | null;
  /** Drawn in place rather than in the title bar: on the TV, which has no title bar. */
  inline?: boolean;
  onBack(): void;
}

export const KaraokeHeader = ({
  visible,
  consoleToggle,
  inline = false,
  onBack,
}: KaraokeHeaderProps) => {
  useLocale();

  const header = (
    <header className="karaokeTop" data-hidden={!visible || undefined}>
      <div className="karaokeNav">
        <IconButton
          round
          icon="back"
          size="lg"
          label={tr(ru.library)}
          onClick={onBack}
        />
        {consoleToggle && (
          <IconButton
            round
            size="lg"
            icon={consoleToggle.visible ? "down" : "up"}
            label={tr(ru[consoleToggle.visible ? "hideConsole" : "showConsole"])}
            onClick={consoleToggle.onToggle}
          />
        )}
      </div>
    </header>
  );
  const slot = inline ? null : document.getElementById(titleBarLeadingId);
  return slot ? createPortal(header, slot) : header;
};
