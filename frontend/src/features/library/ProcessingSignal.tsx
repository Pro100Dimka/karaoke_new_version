import { ProgressBar, Typography } from "@ad-voice/ui";
import { useText } from "../../i18n/useText";

const clamp = (value: number): number => Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));

/** Processing progress drawn as a waveform that fills with colour from the left, with the stage and percentage beside it. */
export const ProcessingSignal = ({ progress, stage }: { progress: number; stage?: string }) => {
  const t = useText();
  const value = Math.round(clamp(progress));
  return (
    <figure className="processingSignal">
      <ProgressBar variant="wave" label={t("processing")} value={value} />
      <Typography as="figcaption" variant="caption" tone="muted">
        {stage ? `${stage} · ` : ""}<strong>{value}%</strong>
      </Typography>
    </figure>
  );
};
