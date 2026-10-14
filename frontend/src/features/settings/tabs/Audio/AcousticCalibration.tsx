import { useState } from "react";
import { Button, Tooltip, Typography } from "@neo-ui-kit/react";
import type { RuntimeAudioConfiguration } from "../../../../contracts/models";
import { useApp } from "../../../../app/AppContext";
import { useNotify } from "../../../../app/NotificationsProvider";
import { useText } from "../../../../i18n/useText";
import { useSettingsAudio } from "../../../../app/SettingsProvider";

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
  const [latest, setLatest] = useState<{ context: string; milliseconds: number }>();
  // Persisted history never proves that the currently opened default device has been calibrated.
  const measured = audioAvailable
    ? (runtime.calibratedLatencyMs ??
      (latest?.context === activeContext
        ? latest.milliseconds
        : undefined))
    : undefined;

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
      notify(`${t("acousticLatencyFailed")}: ${reasonOf(error)}`, "error");
    } finally {
      setMeasuring(false);
    }
  };

  return (
    <div className="audioAcoustic">
      <div className="audioAcousticRow">
        <Typography variant="body-sm" tone="muted">
          {t("acousticLatency")}:{" "}
          <strong>
            {measured === undefined
              ? t("acousticLatencyUnmeasured")
              : t("millisecondsValue", { value: Math.round(measured) })}
          </strong>
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
              measuring ? "acousticLatencyMeasuring" : "acousticLatencyMeasure",
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
