import FieldTooltipButton from "../FieldTooltipButton";

export default function FloatingLabel({
  id,
  label,
  required = false,
  tooltip
}: {
  id: string;
  label?: string;
  required?: boolean;
  tooltip?: string;
}) {
  if (!label) return null;
  return (
    <span className="ui-text-field-label-row">
      <label className="ui-text-field-label" htmlFor={id}>
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      <FieldTooltipButton tooltip={tooltip} />
    </span>
  );
}
