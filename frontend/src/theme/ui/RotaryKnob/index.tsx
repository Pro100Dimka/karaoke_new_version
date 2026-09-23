import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
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
}

const TICK_COUNT = 41;
const pointOnDial = (angle: number, radius: number) => {
  const radians = (angle * Math.PI) / 180;
  return { x: 100 + Math.cos(radians) * radius, y: 100 + Math.sin(radians) * radius };
};

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
}: RotaryKnobProps) {
  const id = `rotary-knob-${useId().replace(/:/g, "")}`;
  const root = useRef<HTMLLabelElement>(null);
  const drag = useRef<{ value: number; lastY: number } | null>(null);
  const valueRef = useRef(0);
  const [draft, setDraft] = useState<string | null>(null);

  const current = clamp(Number(value) || 0, min, max);
  const range = max - min || 1;
  const ratio = (current - min) / range;
  const percent = Math.round(ratio * 100);
  const factor =
    displayFactor && Number.isFinite(displayFactor) ? displayFactor : null;
  const display = factor ? Math.round(current * factor) : percent;
  const ariaLabel =
    typeof label === "string" || typeof label === "number"
      ? String(label)
      : undefined;
  const resetValue = defaultValue ?? clamp(0, min, max);
  const dialAngle = 135 + ratio * 270;
  const thumb = pointOnDial(dialAngle, 78);

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
    if (Number.isFinite(number))
      commit(
        factor ? number / factor : min + (clamp(number, 0, 100) / 100) * range,
      );
    setDraft(null);
  };

  const style = {
    display: "flex",
    flexDirection: "column",
    touchAction: "none",
    userSelect: "none",
    "--dial-value": `${percent}%`,
    "--dial-progress": `${ratio * 75}%`,
    "--dial-angle": `${ratio * 270 - 135}deg`,
  } as CSSProperties;

  return (
    <label
      ref={root}
      htmlFor={id}
      className={`ui-rotary-knob ui-rotary-knob--${accent} ui-control`}
      data-size={size}
      data-disabled={disabled || undefined}
      aria-disabled={disabled || undefined}
      style={style}
      onPointerDown={(event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (
          disabled ||
          event.button !== 0 ||
          target?.closest("input, .ui-rotary-knob__value")
        )
          return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        const control = target?.closest(".ui-rotary-knob__control");
        const next = control
          ? change(
              getRotaryPointerValue({
                clientX: event.clientX,
                clientY: event.clientY,
                rect: control.getBoundingClientRect(),
                min,
                max,
              }),
            )
          : valueRef.current;
        drag.current = { value: next, lastY: event.clientY };
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
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
    >
      <span className="ui-rotary-knob__label">{label}</span>
      <span
        className="ui-rotary-knob__control"
        aria-hidden
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!disabled) commit(resetValue);
        }}
      >
        <svg className="ui-rotary-knob__dial" viewBox="0 0 200 200" focusable="false" aria-hidden="true">
          <defs>
            <radialGradient id={`${id}-metal`} cx="35%" cy="25%" r="78%">
              <stop offset="0" className="ui-rotary-knob__metal-highlight" />
              <stop offset="0.24" className="ui-rotary-knob__metal-mid" />
              <stop offset="0.53" className="ui-rotary-knob__metal-dark" />
              <stop offset="0.76" className="ui-rotary-knob__metal-mid" />
              <stop offset="1" className="ui-rotary-knob__metal-edge" />
            </radialGradient>
            <linearGradient id={`${id}-shine`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="white" stopOpacity="0.38" />
              <stop offset="0.38" stopColor="white" stopOpacity="0" />
              <stop offset="0.72" stopColor="white" stopOpacity="0.2" />
              <stop offset="1" stopColor="white" stopOpacity="0" />
            </linearGradient>
            <filter id={`${id}-glow`} x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur stdDeviation="3.2" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>
          <circle className="ui-rotary-knob__halo" cx="100" cy="100" r="83" />
          <circle className="ui-rotary-knob__track" cx="100" cy="100" r="78" pathLength="100" transform="rotate(135 100 100)" />
          <circle className="ui-rotary-knob__track-active" cx="100" cy="100" r="78" pathLength="100" strokeDasharray={`${ratio * 75} 100`} transform="rotate(135 100 100)" />
          <g className="ui-rotary-knob__scale">
            {Array.from({ length: TICK_COUNT }, (_, index) => {
              const tickRatio = index / (TICK_COUNT - 1);
              const angle = 135 + tickRatio * 270;
              const major = index % 10 === 0;
              const inner = pointOnDial(angle, major ? 63 : 66);
              const outer = pointOnDial(angle, 71);
              return <line key={`tick-${angle}`} className={`ui-rotary-knob__tick${major ? " ui-rotary-knob__tick--major" : ""}${tickRatio <= ratio ? " is-active" : ""}`} x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} />;
            })}
          </g>
          <g className="ui-rotary-knob__scale-values">
            {[0, 25, 50, 75, 100].map((scaleValue) => {
              const position = pointOnDial(135 + (scaleValue / 100) * 270, 91);
              return <text key={`scale-${scaleValue}`} className="ui-rotary-knob__scale-label" x={position.x} y={position.y} dy="0.35em">{scaleValue}</text>;
            })}
          </g>
          <circle className="ui-rotary-knob__grip-shadow" cx="100" cy="100" r="61" />
          <circle className="ui-rotary-knob__grip" cx="100" cy="100" r="58" />
          <circle className="ui-rotary-knob__metal" cx="100" cy="100" r="54" fill={`url(#${id}-metal)`} />
          <path className="ui-rotary-knob__metal-shine" d="M61 65 C79 43 119 37 143 61 C117 54 84 70 68 100 C60 90 57 76 61 65Z" fill={`url(#${id}-shine)`} />
          <g className="ui-rotary-knob__indicator" transform={`rotate(${dialAngle + 90} 100 100)`}>
            <line x1="100" y1="68" x2="100" y2="48" />
          </g>
          <circle className="ui-rotary-knob__thumb-glow" cx={thumb.x} cy={thumb.y} r="8" filter={`url(#${id}-glow)`} />
          <circle className="ui-rotary-knob__thumb" cx={thumb.x} cy={thumb.y} r="6" />
        </svg>
      </span>
      <span className="ui-rotary-knob__value">
        {draft !== null ? (
          <input
            autoFocus
            className="ui-control"
            data-size="xs"
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
        ) : (
          <strong
            onDoubleClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (!disabled) setDraft(String(display));
            }}
          >
            {display}%
          </strong>
        )}
      </span>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={current}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-valuetext={`${display}%`}
        onChange={(event) => commit(Number(event.target.value))}
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clipPath: "inset(50%)",
          pointerEvents: "none",
        }}
      />
    </label>
  );
}
