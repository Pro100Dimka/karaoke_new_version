import { Waveform } from "@neo-ui-kit/react";
import type { SongDto } from "../../contracts/models";
import { useWaveformPeaks } from "../../shared/hooks/useWaveformPeaks";
import { useText } from "../../i18n/useText";

const emptyPeaks: readonly number[] = [];

const clamp = (value: number): number =>
  Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));

/** Compact library waveform; detailed progress belongs to the processing queue. */
export const ProcessingSignal = ({
  progress,
  song,
}: {
  progress: number;
  song?: SongDto;
}) => {
  const t = useText();
  const value = Math.round(clamp(progress));
  const peaks = useWaveformPeaks(song?.id ?? "", song?.activeRevision ?? 1, Boolean(song));
  return (
    <figure className="processingSignal">
      <div role="progressbar" aria-label={t("processing")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
        <Waveform points={peaks ?? emptyPeaks} duration={100} position={value} disabled label={t("processing")} />
      </div>
    </figure>
  );
};
