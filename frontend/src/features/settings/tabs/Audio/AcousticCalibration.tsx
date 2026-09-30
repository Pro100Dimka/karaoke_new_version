import { useState } from "react";
import type { RuntimeAudioConfiguration } from "../../../../contracts/models";
import { useApp } from "../../../../app/AppContext";
import { useNotify } from "../../../../app/NotificationsProvider";
import { useText } from "../../../../i18n/useText";
import { audioClient } from "../../../../services/audioClient";
import { acousticLatencyKey } from "../../../../shared/preferences/preferences";
import { Button, Tooltip } from "../../../../theme/ui";

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
  const t = useText();
  const notify = useNotify();
  const { preferences, updatePreferences } = useApp();
  const [measuring, setMeasuring] = useState(false);
  const key = acousticLatencyKey(preferences.audio);
  const activeContext = runtime.calibrationContext ?? "";
  const [latest, setLatest] = useState<{ key: string; milliseconds: number }>();
  // Persisted history never proves that the currently opened default device has been calibrated.
  const measured = audioAvailable
    ? (runtime.calibratedLatencyMs ?? (latest?.key === `${key}|${activeContext}` ? latest.milliseconds : undefined))
    : undefined;

  const measure = async () => {
    setMeasuring(true);
    try {
      const milliseconds = Math.round(
        await audioClient.measureAcousticLatency(),
      );
      setLatest({ key: `${key}|${activeContext}`, milliseconds });
      updatePreferences({
        acousticLatencyMs: {
          ...preferences.acousticLatencyMs,
          [key]: milliseconds,
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
    <>
      <div className="audioAcousticRow">
        <span className="muted">
          {t("acousticLatency")}:{" "}
          <strong>
            {measured === undefined
              ? t("acousticLatencyUnmeasured")
              : t("millisecondsValue", { value: Math.round(measured) })}
          </strong>
        </span>
        <Tooltip title={t("acousticLatencyHint")}>
          <span>
            <Button
              type="button"
              size="sm"
              variant="outlined"
              tone="neutral"
              disabled={!audioAvailable || measuring}
              onClick={() => void measure()}
            >
              {t(
                measuring
                  ? "acousticLatencyMeasuring"
                  : "acousticLatencyMeasure",
              )}
            </Button>
          </span>
        </Tooltip>
      </div>
      {measured !== undefined && (
        <span className="muted audioAcousticHint">
          {t("acousticLatencyUncertaintyHint")}
        </span>
      )}
    </>
  );
};
