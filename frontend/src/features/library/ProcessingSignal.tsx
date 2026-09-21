import { useId } from "react";
import { useText } from "../../i18n/useText";
import { barsPath, placeholderPeaks, waveBarWidth, waveHeight } from "../../shared/ui/waveBars";
import "./processing-signal.css";

const peaks = placeholderPeaks();
const width = peaks.length * waveBarWidth;
const path = barsPath(peaks);
const clamp = (value: number): number => Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));

/** Processing progress drawn as a waveform that fills with colour from the left, with the percentage beside it. */
export const ProcessingSignal = ({ progress, stage }: { progress: number; stage?: string }) => {
  const t = useText();
  const clipId = `processing-signal-${useId().replace(/:/g, "")}`;
  const value = clamp(progress);
  const rounded = Math.round(value);

  return (
    <figure className="processingSignal" role="progressbar" aria-label={t("processing")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={rounded}>
      <svg viewBox={`0 0 ${width} ${waveHeight}`} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <clipPath id={clipId}>
            <rect x="0" y="0" width={(width * value) / 100} height={waveHeight} />
          </clipPath>
        </defs>
        <path className="processingSignalIdle" d={path} />
        <path className="processingSignalDone" d={path} clipPath={`url(#${clipId})`} />
      </svg>
      <figcaption>
        {stage ? `${stage} · ` : ""}
        <strong>{rounded}%</strong>
      </figcaption>
    </figure>
  );
};
