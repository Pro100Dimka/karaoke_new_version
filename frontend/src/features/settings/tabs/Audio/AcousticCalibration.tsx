import { useState } from "react";
import { useApp } from "../../../../app/AppContext";
import { useNotify } from "../../../../app/NotificationsProvider";
import { useText } from "../../../../i18n/useText";
import { audioClient } from "../../../../services/audioClient";
import { acousticLatencyKey } from "../../../../shared/preferences/preferences";
import { Button, Tooltip } from "../../../../theme/ui";

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
// Wired headphones and converters stay within a few milliseconds; more is wireless audio or DSP.
const wirelessHintMs = 12;

/**
 * Measures the delay the audio drivers do not report (speaker or headphone held to the microphone).
 * Room voices are stamped earlier by it, so partners hear each other on the beat.
 */
export const AcousticCalibration = ({
  audioAvailable,
}: {
  audioAvailable: boolean;
}) => {
  const t = useText();
  const notify = useNotify();
  const { preferences, updatePreferences } = useApp();
  const [measuring, setMeasuring] = useState(false);
  const key = acousticLatencyKey(preferences.audio);
  const measured = preferences.acousticLatencyMs[key];

  const measure = async () => {
    setMeasuring(true);
    try {
      const milliseconds = Math.round(
        await audioClient.measureAcousticLatency(),
      );
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
              : t("millisecondsValue", { value: measured })}
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
      {measured !== undefined && measured > wirelessHintMs && (
        <span className="muted audioAcousticHint">
          {t("acousticLatencyWirelessHint")}
        </span>
      )}
    </>
  );
};
