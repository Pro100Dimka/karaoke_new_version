import { ChevronDown, ChevronUp } from "lucide-react";
import { forwardRef, useRef } from "react";
import { useText } from "../../../i18n/useText";
import Button from "../Button";
import TextField, { type TextFieldProps } from "../TextField";
import cx from "../_internal/cx";
import mergeRefs from "../_internal/mergeRefs";
import "./number-field.css";

export interface NumberFieldProps extends Omit<TextFieldProps, "onChange" | "type"> {
  min?: number;
  max?: number;
  step?: number;
  controls?: boolean;
  onChange?: (value: string) => void;
}

const NumberField = forwardRef<HTMLElement, NumberFieldProps>(function NumberField(
  { value, defaultValue, onChange, min, max, step = 1, disabled = false, readOnly = false, controls = true, className, inputClassName, ...props },
  ref
) {
  const t = useText();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const changeBy = (direction: 1 | -1) => {
    const input = inputRef.current;
    if (!input || disabled || readOnly) return;
    try {
      if (direction > 0) input.stepUp();
      else input.stepDown();
    } catch {
      // Older engines reject stepUp on a non-numeric draft; fall back to manual arithmetic.
      let next = Number(input.value || 0) + (Number(step) || 1) * direction;
      if (min != null) next = Math.max(min, next);
      if (max != null) next = Math.min(max, next);
      input.value = String(next);
    }
    onChange?.(input.value);
    input.focus();
  };

  const controlsSlot = controls ? (
    <span className="ui-number-field-controls" aria-hidden="true">
      {([1, -1] as const).map(direction => (
        <Button
          key={direction}
          className="ui-number-field-step"
          unstyled
          size="sm"
          tabIndex={-1}
          disabled={disabled || readOnly}
          aria-label={t(direction > 0 ? "increase" : "decrease")}
          onMouseDown={event => event.preventDefault()}
          onClick={() => changeBy(direction)}
        >
          {direction > 0 ? <ChevronUp /> : <ChevronDown />}
        </Button>
      ))}
    </span>
  ) : null;

  return (
    <TextField
      {...props}
      ref={mergeRefs<HTMLElement>(ref, inputRef as never)}
      type="number"
      min={min}
      max={max}
      step={step}
      value={value}
      defaultValue={defaultValue}
      disabled={disabled}
      readOnly={readOnly}
      className={cx("ui-number-field", className)}
      inputClassName={cx("ui-number-field-input", inputClassName)}
      end={controlsSlot}
      onChange={next => onChange?.(next)}
    />
  );
});

export default NumberField;
