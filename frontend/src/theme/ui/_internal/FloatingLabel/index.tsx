import FieldTooltipButton from "../FieldTooltipButton";
import type { HTMLAttributes } from "react";

type FloatingLabelProps = {
  id: string;
  label?: string;
  required?: boolean;
  tooltip?: string;
} & HTMLAttributes<HTMLSpanElement>;

export default function FloatingLabel({
  id,
  label,
  required = false,
  tooltip,
  ...props
}: FloatingLabelProps) {
  if (!label) return null;
  return (
    <span className="ui-text-field-label-row" {...props}>
      <label className="ui-text-field-label" htmlFor={id}>
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      <FieldTooltipButton tooltip={tooltip} />
    </span>
  );
}
