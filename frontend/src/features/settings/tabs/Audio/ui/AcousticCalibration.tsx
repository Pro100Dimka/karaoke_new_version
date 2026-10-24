import { Button, Tooltip, Typography } from "@neo-ui-kit/react";
import type { RuntimeAudioConfiguration } from "../../../../../contracts/models";
import { useText } from "../../../../../i18n/useText";
import { useAcousticCalibration } from "../hooks/useAcousticCalibration";

/** Measures acoustic delay from test signals; the result does not identify its physical cause. */
export const AcousticCalibration = ({
  audioAvailable,
  runtime,
}: {
  audioAvailable: boolean;
  runtime: RuntimeAudioConfiguration;
}) => {
  const t = useText();
  const { measuring, measured, measuredHere, measure } = useAcousticCalibration(
    audioAvailable,
    runtime,
  );
  // A measurement made right here is from test signals even before the runtime reports it.
  const sourceKey =
    runtime.calibratedLatencyMs === undefined || measuredHere
      ? "latencySourceTestSignal"
      : runtime.calibrationOrigin === "SONG"
        ? "latencySourceSong"
        : runtime.calibrationOrigin === "PROFILE"
          ? "latencySourceProfile"
          : "latencySourceTestSignal";
  return (
    <div className="audioAcoustic">
      <div className="audioAcousticRow">
        <Typography variant="caption" tone="muted">
          {measured === undefined
            ? t("latencyPartAcousticUnknown")
            : t("latencyPartAcoustic", {
                value: Math.round(measured),
                source: t(sourceKey),
              })}
        </Typography>
        <Tooltip content={t("acousticLatencyHint")}>
          <Button
            size="sm"
            icon="target"
            loading={measuring}
            disabled={!audioAvailable || measuring}
            onClick={() => void measure()}
          >
            {t(
              measuring
                ? "acousticLatencyMeasuring"
                : measured === undefined
                  ? "acousticLatencyMeasure"
                  : "acousticLatencyRecheck",
            )}
          </Button>
        </Tooltip>
      </div>
      {measured !== undefined && (
        <Typography variant="caption" tone="muted">
          {t("acousticLatencyUncertaintyHint")}
        </Typography>
      )}
    </div>
  );
};
