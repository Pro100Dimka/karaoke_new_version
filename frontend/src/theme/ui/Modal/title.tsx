import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import Stack from "../Stack";
import Typography from "../Typography";
import Primitive from "../_internal/Primitive";

export interface ModalTitleProps {
  icon?: LucideIcon;
  image?: string;
  onImageError?: () => void;
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}

export default function ModalTitle({ icon: Icon, image, onImageError, eyebrow, title, description }: ModalTitleProps) {
  return (
    <Stack className="ui-modal-title" direction="row" align="center" gap="var(--space-4)">
      {(Icon || image) && (
        <Primitive className="ui-modal-title-media">
          {image ? <img src={image} alt="" decoding="async" onError={onImageError} /> : Icon && <Icon />}
        </Primitive>
      )}
      <Stack gap="var(--space-1)" className="ui-modal-title-copy">
        {eyebrow && (
          <Typography variant="caption" className="ui-modal-title-eyebrow">
            {eyebrow}
          </Typography>
        )}
        <Typography variant="h3" noWrap>
          {title}
        </Typography>
        {description && (
          <Typography variant="body2" tone="muted">
            {description}
          </Typography>
        )}
      </Stack>
    </Stack>
  );
}
