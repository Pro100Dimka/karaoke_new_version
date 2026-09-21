import { Info } from "lucide-react";
import { useText } from "../../../i18n/useText";
import IconButton from "../IconButton";
import Tooltip from "../Tooltip";

export default function FieldTooltipButton({ tooltip }: { tooltip?: string }) {
  const t = useText();
  if (!tooltip) return null;
  return (
    <Tooltip title={tooltip} placement="top">
      <IconButton
        variant="ghost"
        size="sm"
        aria-label={t("moreInfo")}
        onMouseDown={event => event.preventDefault()}
      >
        <Info size={14} />
      </IconButton>
    </Tooltip>
  );
}
