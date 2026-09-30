import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type MouseEventHandler,
  type ReactNode,
  type RefObject,
} from "react";
import IconButton, { type IconButtonProps } from "../IconButton";
import cx from "../_internal/cx";
import { RotaryKnobArtwork } from "./RotaryKnobArtwork";
import "./rotary-knob.css";
import {
  clamp,
  getRotaryDragValue,
  getRotaryPointerValue,
  getRotaryWheelValue,
} from "./utils";

export type RotaryKnobButtonProps = Omit<
  IconButtonProps,
  "size" | "icon" | "children" | "onClick" | "label"
> & {
  icon: ReactNode;
  onClick: MouseEventHandler<HTMLButtonElement>;
  tooltip: string;
  anchorRef?: RefObject<HTMLElement | null>;
  pressed?: boolean;
} & {
  [name: `data-${string}`]: string | number | boolean | undefined;
};

export interface RotaryKnobProps {
  label?: string | ReactNode;
  /** Accessible name when `label` is not plain text. */
  ariaLabel?: string;
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  defaultValue?: number;
  onChange?: (value: number) => void;
  onCommit?: (value: number) => void;
  accent?: string;
  size?: "xs" | "sm" | "md" | "lg";
  /** An exact size (any CSS length) instead of the responsive preset, for a layout drawn to a fixed design. */
  sizeValue?: string;
  disabled?: boolean;
  displayFactor?: number;
  valueSuffix?: string;
  btnProps?: RotaryKnobButtonProps;
}

const responsiveSizes = {
  xs: "clamp(3.25rem, min(4.25vw, 7.5vh), 4.5rem)",
  sm: "clamp(4rem, min(5.25vw, 9.5vh), 5.75rem)",
  md: "clamp(4.5rem, min(6.25vw, 11.5vh), 7rem)",
  lg: "clamp(5rem, min(7vw, 14vh), 8.5rem)",
} as const;

const actionSizes = { xs: 20, sm: 24, md: 28, lg: 32 } as const;

export default function RotaryKnob({
  label,
  ariaLabel: ariaLabelProp,
  value = 0,
  min = 0,
  max = 1,
  step = 0.05,
  defaultValue,
  onChange,
  onCommit,
  accent = "primary",
  size = "lg",
  sizeValue,
  disabled = false,
  displayFactor,
  valueSuffix = "%",
  btnProps,
}: RotaryKnobProps) {
  const id = `rotary-knob-${useId().replace(/:/g, "")}`;
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ value: number; lastY: number } | null>(null);
  const bodyDoubleClickArmed = useRef(false);
  const valueRef = useRef(0);
  const [draft, setDraft] = useState<string | null>(null);

  const current = clamp(Number(value) || 0, min, max);
  const range = max - min || 1;
  const ratio = (current - min) / range;
  const percent = Math.round(ratio * 100);
  const factor =
    displayFactor && Number.isFinite(displayFactor) ? displayFactor : null;
  const display = factor ? Math.round(current * factor) : percent;
  const displayText = `${display}${valueSuffix}`;
  const ariaLabel =
    ariaLabelProp ??
    (typeof label === "string" || typeof label === "number"
      ? String(label)
      : undefined);
  const resetValue = defaultValue ?? clamp(0, min, max);

  useEffect(() => {
    if (!drag.current) valueRef.current = current;
  }, [current]);

  const change = (next: number): number => {
    if (disabled || !Number.isFinite(next)) return valueRef.current;
    const clamped = clamp(next, min, max);
    valueRef.current = clamped;
    onChange?.(clamped);
    return clamped;
  };

  const commit = (next: number): number | undefined => {
    if (disabled) return undefined;
    const clamped = change(next);
    onCommit?.(clamped);
    return clamped;
  };

  useEffect(() => {
    const node = root.current;
    if (!node) return undefined;
    const onWheel = (event: WheelEvent) => {
      if (disabled) return;
      event.preventDefault();
      commit(
        getRotaryWheelValue({
          value: valueRef.current,
          deltaY: event.deltaY,
          step,
          min,
          max,
          fine: event.shiftKey,
        }),
      );
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [disabled, min, max, step, onChange, onCommit]);

  const stopDrag = () => {
    if (drag.current) onCommit?.(drag.current.value);
    drag.current = null;
  };

  const saveDraft = () => {
    const number = draft?.trim() === "" ? Number.NaN : Number(draft);
    if (Number.isFinite(number)) {
      commit(
        factor ? number / factor : min + (clamp(number, 0, 100) / 100) * range,
      );
    }
    setDraft(null);
  };

  const style = {
    display: "flex",
    flexDirection: "column",
    inlineSize: "var(--rotary-size)",
    flex: "0 0 var(--rotary-size)",
    touchAction: "none",
    userSelect: "none",
    "--rotary-size": sizeValue ?? responsiveSizes[size],
  } as CSSProperties;

  const renderAction = () => {
    if (!btnProps) return null;
    const {
      anchorRef,
      icon,
      onClick,
      tooltip,
      disabled: actionDisabled,
      pressed,
      className,
      variant,
      iconSize,
      ...iconButtonProps
    } = btnProps;

    return (
      <IconButton
        {...iconButtonProps}
        ref={anchorRef}
        variant={variant ?? (pressed === false ? "outline" : "contained")}
        className={cx("ui-rotary-knob__action", className)}
        size={size}
        iconSize={iconSize ?? actionSizes[size]}
        label={tooltip}
        aria-pressed={pressed}
        title={tooltip}
        disabled={disabled || actionDisabled}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onClick(event);
        }}
      >
        {icon}
      </IconButton>
    );
  };

  return (
    <div
      ref={root}
      className={`ui-rotary-knob ui-rotary-knob--${accent} ui-control${btnProps ? " ui-rotary-knob--with-action" : ""}`}
      data-size={size}
      data-disabled={disabled || undefined}
      aria-disabled={disabled || undefined}
      style={style}
      onPointerDown={(event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (
          disabled ||
          event.button > 0 ||
          target?.closest("input, button, .ui-rotary-knob__value")
        )
          return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        const control = target?.closest(".ui-rotary-knob__control");
        if (!control) return;
        const pressedDial = Boolean(
          target?.closest(".ui-rotary-knob__rotating-dial"),
        );
        bodyDoubleClickArmed.current = pressedDial;
        const next = pressedDial
          ? valueRef.current
          : change(
              getRotaryPointerValue({
                clientX: event.clientX,
                clientY: event.clientY,
                rect: control.getBoundingClientRect(),
                min,
                max,
              }),
            );
        drag.current = { value: next, lastY: event.clientY };
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        if (event.clientY !== drag.current.lastY)
          bodyDoubleClickArmed.current = false;
        drag.current.value = change(
          getRotaryDragValue({
            value: drag.current.value,
            lastY: drag.current.lastY,
            clientY: event.clientY,
            min,
            max,
            fine: event.shiftKey,
          }),
        );
        drag.current.lastY = event.clientY;
      }}
      onPointerUp={stopDrag}
      onPointerCancel={stopDrag}
      onLostPointerCapture={stopDrag}
      onDoubleClick={(event) => {
        if (!bodyDoubleClickArmed.current || disabled) return;
        event.preventDefault();
        event.stopPropagation();
        bodyDoubleClickArmed.current = false;
        commit(resetValue);
      }}
    >
      <RotaryKnobArtwork id={id} ratio={ratio} />

      {renderAction()}
      <span className="ui-rotary-knob__footer">
        <span className="ui-rotary-knob__value">
          {draft !== null ? (
            <span className="ui-rotary-knob__value-editor">
              <input
                autoFocus
                className="ui-rotary-knob__value-input"
                type="text"
                inputMode="decimal"
                value={draft}
                aria-label={ariaLabel}
                onFocus={(event) => event.target.select()}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={saveDraft}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") setDraft(null);
                }}
              />
              {valueSuffix ? <span aria-hidden>{valueSuffix}</span> : null}
            </span>
          ) : (
            <strong
              onDoubleClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!disabled) setDraft(String(display));
              }}
            >
              {displayText}
            </strong>
          )}
        </span>
      </span>
      <span className="ui-rotary-knob__label">{label}</span>

      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={current}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-valuetext={displayText}
        onChange={(event) => commit(Number(event.target.value))}
        className="ui-rotary-knob__native"
      />
    </div>
  );
}
