import { forwardRef, type ChangeEvent, type FormEvent, type InputHTMLAttributes, type KeyboardEvent, type PointerEvent } from "react";
import OutlinedInput from "../OutlinedInput";
import FieldMessage from "../_internal/FieldMessage";
import FloatingLabel from "../_internal/FloatingLabel";
import cx from "../_internal/cx";
import mergeSx from "../_internal/sx";
import type { ControlSize, StyleVars } from "../_internal/types";
import useControllable from "../_internal/useControllable";
import useFieldIds from "../_internal/useFieldIds";
import "./slider.css";

const COMMIT_KEYS: ReadonlySet<string> = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Number(value) || 0));

export interface SliderProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "value" | "defaultValue" | "onChange" | "onInput" | "style"> {
  label?: string;
  tooltip?: string;
  hint?: string;
  error?: string;
  min?: number;
  max?: number;
  step?: number;
  value?: number;
  defaultValue?: number;
  size?: ControlSize;
  orientation?: "horizontal" | "vertical";
  showValue?: boolean;
  formatValue?: (value: number) => string;
  fieldClassName?: string;
  sx?: StyleVars;
  style?: StyleVars;
  controlSx?: StyleVars;
  controlStyle?: StyleVars;
  fieldSx?: StyleVars;
  fieldStyle?: StyleVars;
  onInput?: (value: number, event: FormEvent<HTMLInputElement>) => void;
  onChange?: (value: number, event?: ChangeEvent<HTMLInputElement>) => void;
  onCommit?: (value: number, event: PointerEvent<HTMLInputElement> | KeyboardEvent<HTMLInputElement>) => void;
}

const Slider = forwardRef<HTMLInputElement, SliderProps>(
  (
    {
      id,
      label,
      tooltip,
      hint,
      error,
      required = false,
      min = 0,
      max = 100,
      step = 1,
      value,
      defaultValue,
      disabled = false,
      size = "md",
      orientation = "horizontal",
      showValue = true,
      formatValue = String,
      className,
      fieldClassName,
      sx,
      style,
      onInput,
      onChange,
      controlSx,
      controlStyle,
      fieldSx,
      fieldStyle,
      onCommit,
      ...props
    },
    ref
  ) => {
    const { controlId, hintId, errorId, describedBy } = useFieldIds("ui-slider", id, hint, error);
    const [current, setCurrent] = useControllable<number, ChangeEvent<HTMLInputElement>>(value, defaultValue ?? min, onChange);
    const safe = clamp(current, min, max);
    const percent = ((safe - min) / Math.max(0.000001, max - min)) * 100;

    const input = (
      <input
        ref={ref}
        id={controlId}
        type="range"
        className={cx("ui-slider", "ui-control", "ui-disabled", className)}
        data-size={size}
        min={min}
        max={max}
        step={step}
        value={safe}
        disabled={disabled}
        required={required}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        aria-orientation={orientation}
        data-orientation={orientation}
        style={mergeSx({ "--slider-value": `${percent}%`, ...sx }, style)}
        onInput={event => onInput?.(Number(event.currentTarget.value), event)}
        onChange={event => setCurrent(Number(event.currentTarget.value), event)}
        onPointerUp={event => onCommit?.(Number(event.currentTarget.value), event)}
        onKeyUp={event => {
          if (COMMIT_KEYS.has(event.key)) onCommit?.(Number(event.currentTarget.value), event);
        }}
        {...props}
      />
    );

    const control = (
      <span
        className="ui-slider-control ui-control"
        data-size={size}
        data-disabled={disabled || undefined}
        data-orientation={orientation}
        style={mergeSx(controlSx, controlStyle)}
      >
        {input}
        {showValue && (
          <output className="ui-slider-value" htmlFor={controlId}>
            {formatValue(safe)}
          </output>
        )}
      </span>
    );

    if (!label && !hint && !error) return control;

    return (
      <div
        className={cx("ui-field", "ui-slider-field", fieldClassName)}
        data-disabled={disabled || undefined}
        data-error={!!error || undefined}
        style={mergeSx(fieldSx, fieldStyle)}
      >
        <OutlinedInput
          label={label}
          labelAccessory={Boolean(tooltip)}
          labelNode={<FloatingLabel id={controlId} label={label} required={required} tooltip={tooltip} />}
          required={required}
          disabled={disabled}
          error={!!error}
          size={size}
          className="ui-slider-frame"
          data-filled
        >
          {control}
        </OutlinedInput>
        <FieldMessage errorId={errorId} hintId={hintId} error={error} hint={hint} />
      </div>
    );
  }
);

Slider.displayName = "Slider";
export default Slider;
