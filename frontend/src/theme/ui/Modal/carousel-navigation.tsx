import { ChevronLeft, ChevronRight } from "lucide-react";
import { useText } from "../../../i18n/useText";
import IconButton from "../IconButton";
import Stack from "../Stack";
import Typography from "../Typography";

export interface ModalCarouselNavigationProps {
  ariaLabel?: string;
  index: number;
  count: number;
  title: string;
  subtitle?: string;
  previousLabel?: string;
  nextLabel?: string;
  onPrevious?: () => void;
  onNext?: () => void;
}

export default function ModalCarouselNavigation({
  ariaLabel,
  index,
  count,
  title,
  subtitle,
  previousLabel,
  nextLabel,
  onPrevious,
  onNext
}: ModalCarouselNavigationProps) {
  const t = useText();
  if (count <= 1) return null;
  return (
    <Stack className="ui-modal-carousel" direction="row" align="center" justify="space-between" aria-label={ariaLabel}>
      <IconButton icon={ChevronLeft} label={previousLabel ?? t("back")} disabled={index <= 0} onClick={onPrevious} />
      <Stack align="center" gap="var(--space-1)" aria-live="polite">
        <Typography noWrap>{title}</Typography>
        {subtitle && (
          <Typography variant="caption" tone="muted">
            {subtitle}
          </Typography>
        )}
      </Stack>
      <IconButton icon={ChevronRight} label={nextLabel ?? t("next")} disabled={index >= count - 1} onClick={onNext} />
    </Stack>
  );
}
