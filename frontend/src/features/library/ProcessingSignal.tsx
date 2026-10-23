import { ProgressBar } from "@neo-ui-kit/react";
import { useText } from "../../i18n/useText";

const clamp = (value: number): number =>
  Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));

/** Compact library waveform; detailed progress belongs to the processing queue. */
export const ProcessingSignal = ({
  progress,
}: {
  progress: number;
}) => {
  const t = useText();
  const value = Math.round(clamp(progress));
  return (
    <figure className="processingSignal">
      <ProgressBar variant="wave" label={t("processing")} value={value} />
    </figure>
  );
};
