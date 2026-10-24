import { Button, Tooltip, Typography } from "@neo-ui-kit/react";
import { useState } from "react";
import { useApp } from "../../../../app/AppContext";
import { useNotify } from "../../../../app/NotificationsProvider";
import type { RuntimeAudioConfiguration } from "../../../../contracts/models";
import { useText } from "../../../../i18n/useText";
import { useSettingsAudio } from "../../SettingsProvider";

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Measures acoustic delay relative to driver timestamps; this cannot identify its physical cause.
 */
export const AcousticCalibration = ({
  audioAvailable,
  runtime,
}: {
  audioAvailable: boolean;
  runtime: RuntimeAudioConfiguration;
}) => {
  const audio = useSettingsAudio();
  const t = useText();
  const notify = useNotify();
  const { preferences, updatePreferences } = useApp("preferences");
  const [measuring, setMeasuring] = useState(false);
  const activeContext = runtime.calibrationContext ?? "";
  const [latest, setLatest] = useState<{
    context: string;
    milliseconds: number;
  }>();
  // Persisted history never proves that the currently opened default device has been calibrated.
  const measured = audioAvailable
    ? (runtime.calibratedLatencyMs ??
      (latest?.context === activeContext ? latest.milliseconds : undefined))
    : undefined;

  // A measurement made right here is from test signals even before the runtime reports it.
  const sourceKey =
    runtime.calibratedLatencyMs === undefined ||
    latest?.context === activeContext
      ? "latencySourceTestSignal"
      : runtime.calibrationOrigin === "SONG"
        ? "latencySourceSong"
        : runtime.calibrationOrigin === "PROFILE"
          ? "latencySourceProfile"
          : "latencySourceTestSignal";
  const measure = async () => {
    setMeasuring(true);
    try {
      const measured = await audio.measureAcousticLatency();
      const milliseconds = Math.round(measured.milliseconds);
      setLatest({ context: activeContext, milliseconds });
      // Saved for exactly the device path it was measured on, and restored on it after a restart.
      if (measured.fingerprint)
        updatePreferences({
          acousticLatencyMs: {
            ...preferences.acousticLatencyMs,
            [measured.fingerprint]: measured.milliseconds,
          },
        });
      notify(t("acousticLatencyMeasured", { value: milliseconds }), "success");
    } catch (error) {
      // Playing a song ends the optional measurement on purpose; that is not a failure.
      if (
        error instanceof Error &&
        error.name === "AcousticMeasurementCancelled"
      )
        notify(t("acousticLatencyCancelled"), "info");
      else notify(`${t("acousticLatencyFailed")}: ${reasonOf(error)}`, "error");
    } finally {
      setMeasuring(false);
    }
  };

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
