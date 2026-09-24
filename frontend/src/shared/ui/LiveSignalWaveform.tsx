import { useEffect, useId, useRef } from "react";
import "./live-signal-waveform.css";

const sampleCount = 64;
const width = 256;
const height = 48;
const midline = height / 2;
const frameMilliseconds = 28;
const attackSmoothing = 0.3;
const releaseSmoothing = 0.11;
const emptySignal: readonly number[] = Array.from(
  { length: sampleCount },
  () => 0,
);

const clampLevel = (value: number, max: number): number =>
  Math.max(0, Math.min(1, value / Math.max(max, 0.001)));

const point = (
  position: number,
  amplitude: number,
  direction: 1 | -1,
): string => {
  const x = (position / (sampleCount - 1)) * width;
  const halfHeight = 1 + amplitude ** 0.68 * (midline - 3);
  return `${x.toFixed(2)} ${(midline + direction * halfHeight).toFixed(2)}`;
};

const waveformPath = (samples: readonly number[]): string => {
  const upper = samples.map((sample, position) => point(position, sample, -1));
  const lower = samples
    .map((sample, position) => point(position, sample, 1))
    .reverse();
  return `M ${upper[0]} L ${upper.slice(1).join(" L ")} L ${lower.join(" L ")} Z`;
};

interface LiveSignalWaveformProps {
  active: boolean;
  level: number;
  max?: number;
  compact?: boolean;
  ariaLabel: string;
  title?: string;
  style?: React.CSSProperties;
}

/**
 * Scrolling mirrored waveform of a live level. The path is redrawn imperatively on a timer, so the meter never
 * re-renders React at the animation rate; only `level` and `active` flow in as props.
 */
export const LiveSignalWaveform = ({
  active,
  level,
  max = 1,
  compact = false,
  ariaLabel,
  title,
  style,
}: LiveSignalWaveformProps) => {
  const gradientId = `live-wave-${useId().replace(/:/g, "")}`;
  const pathRef = useRef<SVGPathElement>(null);
  const targetRef = useRef(0);

  useEffect(() => {
    targetRef.current = active ? clampLevel(level, max) : 0;
  }, [active, level, max]);

  useEffect(() => {
    const path = pathRef.current;
    if (!path || !active) {
      path?.setAttribute("d", waveformPath(emptySignal));
      return undefined;
    }
    const samples = [...emptySignal];
    let envelope = 0;
    const draw = () => {
      const target = targetRef.current;
      envelope +=
        (target - envelope) *
        (target > envelope ? attackSmoothing : releaseSmoothing);
      if (envelope < 0.001) envelope = 0;
      samples.shift();
      samples.push(envelope);
      path.setAttribute("d", waveformPath(samples));
    };
    draw();
    const timer = window.setInterval(draw, frameMilliseconds);
    return () => window.clearInterval(timer);
  }, [active]);

  return (
    <div
      className="live-signal-wave"
      data-active={active}
      data-compact={compact || undefined}
      role="meter"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round((active ? clampLevel(level, max) : 0) * 100)}
      title={title}
      style={{ ...style }}
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={gradientId}>
            <stop stopColor="var(--color-secondary)" />
            <stop offset="0.52" stopColor="var(--color-primary)" />
            <stop offset="1" stopColor="var(--color-highlight)" />
          </linearGradient>
        </defs>
        <line
          className="live-signal-wave__axis"
          x2={width}
          y1={midline}
          y2={midline}
        />
        <path
          ref={pathRef}
          className="live-signal-wave__shape"
          d={waveformPath(emptySignal)}
          fill={`url(#${gradientId})`}
        />
      </svg>
    </div>
  );
};
