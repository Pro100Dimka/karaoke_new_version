import { forwardRef, type ChangeEvent, type InputHTMLAttributes, type ReactNode } from "react";
import OutlinedInput from "../OutlinedInput";
import FieldMessage from "../_internal/FieldMessage";
import FloatingLabel from "../_internal/FloatingLabel";
import cx from "../_internal/cx";
import mergeSx from "../_internal/sx";
import type { ControlSize, StyleVars } from "../_internal/types";
import useControllable from "../_internal/useControllable";
import useFieldIds from "../_internal/useFieldIds";
import "./switch.css";

export interface SwitchProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "onChange" | "style" | "checked" | "defaultChecked"> {
  checked?: boolean;
  defaultChecked?: boolean;
  size?: ControlSize;
  variant?: "plain" | "field";
  label?: ReactNode;
  tooltip?: string;
  hint?: string;
  error?: string;
  checkedText?: string;
  uncheckedText?: string;
  fieldClassName?: string;
  sx?: StyleVars;
  style?: StyleVars;
  onChange?: (checked: boolean, event?: ChangeEvent<HTMLInputElement>) => void;
}

const Switch = forwardRef<HTMLInputElement, SwitchProps>(
  (
    {
      id,
      checked,
      defaultChecked,
      disabled = false,
      required = false,
      size = "md",
      variant,
      label,
      tooltip,
      hint,
      error,
      checkedText,
      uncheckedText,
      className,
      fieldClassName,
      sx,
      style,
      onChange,
      ...props
    },
    ref
  ) => {
    const { controlId, hintId, errorId, describedBy } = useFieldIds("ui-switch", id, hint, error);
    const [current, setCurrent] = useControllable<boolean, ChangeEvent<HTMLInputElement>>(checked, defaultChecked ?? false, onChange);

    const input = (
      <input
        ref={ref}
        id={controlId}
        type="checkbox"
        role="switch"
        className={cx("ui-switch", "ui-control", "ui-focus-ring", "ui-disabled", "ui-motion", className)}
        data-size={size}
        checked={Boolean(current)}
        disabled={disabled}
        required={required}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        onChange={event => setCurrent(event.target.checked, event)}
        style={mergeSx(sx, style)}
        {...props}
      />
    );

    if (!label) return input;
    if (variant === "plain") {
      return (
        <label className="ui-switch-label ui-control" data-size={size} data-disabled={disabled || undefined}>
          {input}
          <span>{label}</span>
        </label>
      );
    }

    const status = current ? checkedText : uncheckedText;
    return (
      <div
        className={cx("ui-field", "ui-switch-field-wrap", fieldClassName)}
        data-disabled={disabled || undefined}
        data-error={!!error || undefined}
      >
        <OutlinedInput
          label={typeof label === "string" ? label : undefined}
          labelAccessory={Boolean(tooltip)}
          labelNode={
            <FloatingLabel id={controlId} label={typeof label === "string" ? label : undefined} required={required} tooltip={tooltip} />
          }
          required={required}
          disabled={disabled}
          error={!!error}
          size={size}
          className="ui-switch-field"
          data-filled
        >
          <span className="ui-switch-control">
            {status && <span className="ui-switch-status">{status}</span>}
            {input}
          </span>
        </OutlinedInput>
        <FieldMessage errorId={errorId} hintId={hintId} error={error} hint={hint} />
      </div>
    );
  }
);

Switch.displayName = "Switch";
export default Switch;
