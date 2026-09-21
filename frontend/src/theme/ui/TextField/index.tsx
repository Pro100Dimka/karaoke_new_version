import { forwardRef, type ChangeEvent, type InputHTMLAttributes, type ReactNode } from "react";
import InputBase from "../InputBase";
import OutlinedInput from "../OutlinedInput";
import FieldMessage from "../_internal/FieldMessage";
import FloatingLabel from "../_internal/FloatingLabel";
import cx from "../_internal/cx";
import type { ControlSize, StyleVars } from "../_internal/types";
import useFieldIds from "../_internal/useFieldIds";
import "./text-field.css";

export interface TextFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "onChange" | "value" | "defaultValue" | "style"> {
  label?: string;
  hint?: string;
  tooltip?: string;
  error?: string;
  multiline?: boolean;
  size?: ControlSize;
  tone?: string;
  start?: ReactNode;
  end?: ReactNode;
  startAdornment?: ReactNode;
  endAdornment?: ReactNode;
  fieldClassName?: string;
  inputClassName?: string;
  fullWidth?: boolean;
  value?: string | number | null;
  defaultValue?: string | number;
  rows?: number;
  sx?: StyleVars;
  style?: StyleVars;
  onChange?: (value: string, event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
}

const TextField = forwardRef<HTMLElement, TextFieldProps>(
  (
    {
      id,
      label,
      hint,
      tooltip,
      error,
      required = false,
      disabled = false,
      readOnly = false,
      multiline = false,
      type = "text",
      size = "md",
      tone = "default",
      start,
      end,
      startAdornment,
      endAdornment,
      className,
      fieldClassName,
      sx,
      style,
      inputClassName,
      fullWidth = false,
      value,
      defaultValue,
      onChange,
      placeholder,
      rows,
      ...props
    },
    ref
  ) => {
    const { controlId, hintId, errorId, describedBy } = useFieldIds("ui-text-field", id, hint, error);
    const startSlot = startAdornment ?? start;
    const endSlot = endAdornment ?? end;
    const hasFrame = Boolean(label || hint || error || startSlot || endSlot);

    const control = (
      <InputBase
        ref={ref}
        component={multiline ? "textarea" : "input"}
        id={controlId}
        className={cx(
          "ui-text-field-input ui-control ui-disabled ui-motion",
          fullWidth && "ui-text-field-full-width",
          inputClassName,
          !hasFrame && className
        )}
        size={size}
        tone={tone}
        disabled={disabled}
        readOnly={readOnly}
        required={required}
        value={value !== undefined ? (value ?? "") : undefined}
        defaultValue={value === undefined ? defaultValue : undefined}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange?.(event.target.value, event)}
        placeholder={placeholder ?? (label ? " " : undefined)}
        rows={multiline ? rows : undefined}
        type={multiline ? undefined : type}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        sx={!hasFrame ? sx : undefined}
        style={!hasFrame ? style : undefined}
        {...props}
      />
    );

    if (!hasFrame) return control;

    const framed = (
      <OutlinedInput
        label={label}
        labelAccessory={Boolean(tooltip)}
        labelNode={<FloatingLabel id={controlId} label={label} required={required} tooltip={tooltip} />}
        required={required}
        disabled={disabled}
        error={!!error}
        size={size}
        tone={tone}
        start={startSlot}
        end={endSlot}
        className={cx(className, fullWidth && "ui-text-field-full-width", !label && "ui-text-field-no-label")}
        sx={sx}
        style={style}
      >
        {control}
      </OutlinedInput>
    );

    if (!label && !hint && !error) return framed;

    return (
      <div
        className={cx("ui-field", fullWidth && "ui-field-full-width", fieldClassName)}
        data-disabled={disabled || undefined}
        data-error={!!error || undefined}
      >
        {framed}
        <FieldMessage errorId={errorId} hintId={hintId} error={error} hint={hint} />
      </div>
    );
  }
);

TextField.displayName = "TextField";
export default TextField;
