import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Modal as ThemeModal } from "../../theme/ui";
import "./modal.css";

interface ModalProps {
  open: boolean;
  title: string;
  closeLabel: string;
  children: ReactNode;
  onClose(): void;
  className?: string;
  titleIcon?: LucideIcon;
  titleEyebrow?: string;
  titleDescription?: string;
  neonFrame?: ReactNode;
}

/** Application dialog on top of the theme Modal; callers keep the small open/title/onClose contract. */
export const Modal = ({ open, title, closeLabel, children, onClose, className, titleIcon, titleEyebrow, titleDescription, neonFrame }: ModalProps) => (
  <ThemeModal
    isOpen={open}
    onClose={onClose}
    ariaLabel={title}
    closeAriaLabel={closeLabel}
    closeIconSize={40}
    portal
    titleProps={{ title, icon: titleIcon, eyebrow: titleEyebrow, description: titleDescription }}
    modalClassName={className}
    size="lg"
    neonFrame={neonFrame}
  >
    {children}
  </ThemeModal>
);
