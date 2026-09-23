import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import knobBody from "../../../assets/rotary-knob/knob-body.png";
import knobPointer from "../../../assets/rotary-knob/knob-pointer.png";
import thumbArtwork from "../../../assets/rotary-knob/thumb.png";
import trackActive from "../../../assets/rotary-knob/track-active.png";
import "./rotary-knob.css";
import {
  clamp,
  getRotaryDragValue,
  getRotaryPointerValue,
  getRotaryWheelValue,
} from "./utils";

export interface RotaryKnobProps {
  label?: string | ReactNode;
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  defaultValue?: number;
  onChange?: (value: number) => void;
  onCommit?: (value: number) => void;
  accent?: string;
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  displayFactor?: number;
  btnProps?: {
    icon: ReactNode;
    onClick: MouseEventHandler<HTMLButtonElement>;
    tooltip: string;
    disabled?: boolean;
    pressed?: boolean;
  };
}

const pointOnDial = (angle: number, radius: number) => {
  const radians = (angle * Math.PI) / 180;
  return { x: 100 + Math.cos(radians) * radius, y: 100 + Math.sin(radians) * radius };
};

const responsiveSizes = {
  sm: "clamp(4rem, min(5.25vw, 9.5vh), 5.75rem)",
  md: "clamp(4.5rem, min(6.25vw, 11.5vh), 7rem)",
  lg: "clamp(5rem, min(7vw, 14vh), 8.5rem)",
} as const;

export default function RotaryKnob({
  label,
  value = 0,
  min = 0,
  max = 1,
  step = 0.05,
  defaultValue,
  onChange,
  onCommit,
  accent = "primary",
  size = "lg",
  disabled = false,
  displayFactor,
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
  const factor = displayFactor && Number.isFinite(displayFactor) ? displayFactor : null;
  const display = factor ? Math.round(current * factor) : percent;
  const ariaLabel =
    typeof label === "string" || typeof label === "number" ? String(label) : undefined;
  const resetValue = defaultValue ?? clamp(0, min, max);
  const dialAngle = 135 + ratio * 270;
  const thumb = pointOnDial(dialAngle, 72);

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
      commit(getRotaryWheelValue({
        value: valueRef.current,
        deltaY: event.deltaY,
        step,
        min,
        max,
        fine: event.shiftKey,
      }));
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
      commit(factor ? number / factor : min + (clamp(number, 0, 100) / 100) * range);
    }
    setDraft(null);
  };

  const style = {
    display: "flex",
    flexDirection: "column",
    touchAction: "none",
    userSelect: "none",
    "--rotary-size": responsiveSizes[size],
  } as CSSProperties;

  return (
    <div
      ref={root}
      className={`ui-rotary-knob ui-rotary-knob--${accent} ui-control`}
      data-size={size}
      data-disabled={disabled || undefined}
      aria-disabled={disabled || undefined}
      style={style}
      onPointerDown={(event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (disabled || event.button > 0 || target?.closest("input, button, .ui-rotary-knob__value")) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        const control = target?.closest(".ui-rotary-knob__control");
        if (!control) return;
        const pressedDial = Boolean(target?.closest(".ui-rotary-knob__rotating-dial"));
        bodyDoubleClickArmed.current = pressedDial;
        const next = pressedDial
          ? valueRef.current
          : change(getRotaryPointerValue({
              clientX: event.clientX,
              clientY: event.clientY,
              rect: control.getBoundingClientRect(),
              min,
              max,
            }));
        drag.current = { value: next, lastY: event.clientY };
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        if (event.clientY !== drag.current.lastY) bodyDoubleClickArmed.current = false;
        drag.current.value = change(getRotaryDragValue({
          value: drag.current.value,
          lastY: drag.current.lastY,
          clientY: event.clientY,
          min,
          max,
          fine: event.shiftKey,
        }));
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
      <span
        className="ui-rotary-knob__control ui-rotary-knob__reference-shell"
        aria-hidden
      >
        <svg className="ui-rotary-knob__artwork" viewBox="0 0 200 200" focusable="false" aria-hidden="true">
          <defs>
            <mask id={`${id}-track`} maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">
              <circle cx="100" cy="100" r="72" fill="none" stroke="#fff" strokeWidth="8" strokeLinecap="round" pathLength="100" strokeDasharray="75 100" transform="rotate(135 100 100)" />
            </mask>
            <mask id={`${id}-progress`} maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">
              <circle cx="100" cy="100" r="72" fill="none" stroke="#fff" strokeWidth="9" strokeLinecap="round" pathLength="100" strokeDasharray={`${ratio * 75} 100`} transform="rotate(135 100 100)" />
            </mask>
            <clipPath id={`${id}-pointer-half`}>
              <path d="M100 100 L137 56 L144 100 Z" />
            </clipPath>
            <clipPath id={`${id}-body-circle`}>
              <circle cx="100" cy="100" r="59.2" />
            </clipPath>
          </defs>

          <g mask={`url(#${id}-track)`}>
            <svg className="ui-rotary-knob__track-inactive-art" x="10" y="10" width="180" height="180" viewBox="0 0 1254 1254" preserveAspectRatio="none">
              <image href={trackActive} x="0" y="0" width="1254" height="1254" />
            </svg>
          </g>
          <circle
            className="ui-rotary-knob__track-inactive-cap"
            cx={pointOnDial(405, 72).x}
            cy={pointOnDial(405, 72).y}
            r="3"
            fill="#363941"
          />
          <g mask={`url(#${id}-progress)`}>
            <svg className="ui-rotary-knob__track-active-art" x="10" y="10" width="180" height="180" viewBox="0 0 1254 1254" preserveAspectRatio="none">
              <image href={trackActive} x="0" y="0" width="1254" height="1254" />
            </svg>
          </g>
          <circle
            className="ui-rotary-knob__track-active-cap"
            cx={pointOnDial(135, 72).x}
            cy={pointOnDial(135, 72).y}
            r="3"
            fill="#ff173f"
            opacity={ratio > 0 ? 1 : 0}
          />
          <circle
            className="ui-rotary-knob__track-active-cap-core"
            cx={pointOnDial(135, 72).x}
            cy={pointOnDial(135, 72).y}
            r="1.55"
            fill="#fff4f6"
            opacity={ratio > 0 ? 1 : 0}
          />
          <g
            className="ui-rotary-knob__rotating-dial"
            transform={`rotate(${dialAngle + 45} 100 100)`}
            style={{ transition: "none" }}
            clipPath={`url(#${id}-body-circle)`}
          >
            <svg className="ui-rotary-knob__body-art" x="36" y="36" width="128" height="128" viewBox="50 33.5 1157 1157" preserveAspectRatio="none">
              <image href={knobBody} x="0" y="0" width="1254" height="1254" />
            </svg>
            <g className="ui-rotary-knob__pointer-art" clipPath={`url(#${id}-pointer-half)`}>
              <svg x="56" y="56" width="88" height="88" viewBox="57.5 57 1177 1177" preserveAspectRatio="none">
                <image href={knobPointer} x="0" y="0" width="1254" height="1254" />
              </svg>
            </g>
          </g>
          <svg className="ui-rotary-knob__thumb-art" x={thumb.x - 13} y={thumb.y - 13} width="26" height="26" viewBox="20 5 1207 1207" preserveAspectRatio="none">
            <image href={thumbArtwork} x="0" y="0" width="1254" height="1254" />
          </svg>
        </svg>
      </span>

      <span className="ui-rotary-knob__footer">
        {btnProps ? (
          <button
            type="button"
            className="ui-rotary-knob__action"
            aria-label={btnProps.tooltip}
            aria-pressed={btnProps.pressed}
            title={btnProps.tooltip}
            disabled={disabled || btnProps.disabled}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              btnProps.onClick(event);
            }}
          >
            {btnProps.icon}
          </button>
        ) : null}
        <span className="ui-rotary-knob__value">
          {draft !== null ? (
            <span className="ui-rotary-knob__value-editor">
              <input autoFocus className="ui-rotary-knob__value-input" type="text" inputMode="decimal" value={draft} aria-label={ariaLabel} onFocus={(event) => event.target.select()} onChange={(event) => setDraft(event.target.value)} onBlur={saveDraft} onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") setDraft(null);
              }} />
              <span aria-hidden>%</span>
            </span>
          ) : (
            <strong onDoubleClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (!disabled) setDraft(String(display));
            }}>{display}%</strong>
          )}
        </span>
      </span>
      <span className="ui-rotary-knob__label">{label}</span>

      <input id={id} type="range" min={min} max={max} step={step} value={current} disabled={disabled} aria-label={ariaLabel} aria-valuetext={`${display}%`} onChange={(event) => commit(Number(event.target.value))} className="ui-rotary-knob__native" />
    </div>
  );
}
