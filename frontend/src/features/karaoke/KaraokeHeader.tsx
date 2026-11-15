import { createPortal } from 'react-dom';
import { titleBarLeadingId } from '../../app/TitleBar';
import { Button, tr, useLocale } from '@neo-ui-kit/react';

interface KaraokeHeaderProps {
  /** The buttons fade out while the pointer is idle during playback. */
  visible: boolean;
  /** Drawn in place rather than in the title bar: on the TV, which has no title bar. */
  inline?: boolean;
  onBack(): void;
}

export const KaraokeHeader = ({
  visible,
  inline = false,
  onBack,
}: KaraokeHeaderProps) => {
  useLocale();

  const header = (
    <header className="karaokeTop" data-hidden={!visible || undefined}>
      <div className="karaokeNav">
        <Button
          className="karaokeBackButton"
          icon="back"
          size="sm"
          variant="secondary"
          label={tr('library')}
          onClick={onBack}
        />
      </div>
    </header>
  );
  const slot = inline ? null : document.getElementById(titleBarLeadingId);
  return slot ? createPortal(header, slot) : header;
};
