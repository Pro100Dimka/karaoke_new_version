import "./seek-waveform.css";
import { useId, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { barsPath, placeholderPeaks, waveBarWidth, waveHeight } from "./waveBars";

const keyboardStepSeconds = 5;

interface SeekWaveformProps {
  peaks: readonly number[] | null;
  position: number;
  duration: number;
  disabled: boolean;
  label: string;
  onSeek(seconds: number): void;
}

/** Seekable waveform (song instrumental or a saved take): played part in theme colours, click or drag (or arrow keys) to seek. */
export const SeekWaveform = ({ peaks, position, duration, disabled, label, onSeek }: SeekWaveformProps) => {
  const gradientId = `seek-wave-${useId().replace(/:/g, "")}`;
  const surface = useRef<HTMLDivElement>(null);
  const bars = peaks ?? placeholderPeaks();
  const width = bars.length * waveBarWidth;
  const progress = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0;
  const path = barsPath(bars);

  const seekFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const box = surface.current?.getBoundingClientRect();
    if (!box || box.width === 0 || duration <= 0) return;
    onSeek(Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) * duration);
  };
  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    seekFromPointer(event);
  };
  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) seekFromPointer(event);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const step = event.key === "ArrowRight" ? keyboardStepSeconds : event.key === "ArrowLeft" ? -keyboardStepSeconds : 0;
    if (step === 0) return;
    event.preventDefault();
    onSeek(Math.min(duration, Math.max(0, position + step)));
  };

  return (
    <div
      ref={surface}
      className="seekWaveform"
      data-loading={peaks === null || undefined}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(position)}
      aria-disabled={disabled}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onKeyDown={handleKeyDown}
    >
      <svg viewBox={`0 0 ${width} ${waveHeight}`} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id={gradientId} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="var(--color-primary)" />
            <stop offset="1" stopColor="var(--color-highlight)" />
          </linearGradient>
          <clipPath id={`${gradientId}-played`}>
            <rect x="0" y="0" width={width * progress} height={waveHeight} />
          </clipPath>
        </defs>
        <path className="seekWaveformBars" d={path} />
        <path className="seekWaveformPlayed" d={path} stroke={`url(#${gradientId})`} clipPath={`url(#${gradientId}-played)`} />
        <line className="seekWaveformCursor" x1={width * progress} x2={width * progress} y1="0" y2={waveHeight} />
      </svg>
    </div>
  );
};
