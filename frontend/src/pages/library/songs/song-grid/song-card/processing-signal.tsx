import { Stack, Waveform, tr, useLocale } from "@neo-ui-kit/react";
import type { SongDto } from "../../../../../contracts/models";
import { useWaveformPeaks } from "../../../../../shared/hooks/useWaveformPeaks";
import { ru } from "../../../../../i18n/messages.ru";

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
  useLocale();
  const value = Math.round(clamp(progress));
  const peaks = useWaveformPeaks(song?.id ?? "", song?.activeRevision ?? 1, Boolean(song));
  return (
    <Stack style={{ flex: 1, minWidth: 0 }} gap={1}>
      <div role="progressbar" aria-label={tr(ru.processing)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
        <Waveform style={{ height: "2rem", minWidth: 0, cursor: "default", filter: "none" }} points={peaks ?? emptyPeaks} duration={100} position={value} disabled label={tr(ru.processing)} />
      </div>
    </Stack>
  );
};
