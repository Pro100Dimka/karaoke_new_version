import { Info } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { RoomTimingReport } from "../../contracts/clients";
import { useText } from "../../i18n/useText";
import { audioClient } from "../../services/audioClient";
import { Tooltip, Typography } from "../../theme/ui";
import { roomLink } from "./roomLink";
import { RoomSyncQuality } from "./RoomSyncQuality";

const refreshMilliseconds = 2_000;
// Route and stability are judged over about ten seconds, so the line does not flicker.
const linkWindowReports = 5;

/** Room latency, shown from the moment the voice session is up and refreshed without any click. */
export const RoomLatencyPanel = () => {
  const t = useText();
  const [timing, setTiming] = useState<RoomTimingReport | null>(null);
  const history = useRef<RoomTimingReport[]>([]);

  useEffect(() => {
    let active = true;
    const refresh = () =>
      void audioClient.roomTiming().then(
        (report) => {
          if (!active) return;
          history.current = [...history.current, report].slice(-(linkWindowReports + 1));
          setTiming(report);
        },
        () => undefined,
      );
    refresh();
    const timer = window.setInterval(refresh, refreshMilliseconds);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  if (!timing) return null;
  const link = roomLink(
    history.current.length > 1 ? history.current[0] : undefined,
    timing,
  );
  const jitterMs = Math.max(
    0,
    ...Object.values(timing.remotes).map((remote) => remote.jitterMs),
  );
  // The playout delay is what everyone hears; before any voice arrives only the estimate exists.
  const delayMs =
    timing.voiceDelayMs > 0
      ? timing.voiceDelayMs
      : timing.estimatedVoiceLatencyMs;
  const details = (
    <span className="roomTimingDetails">
      <RoomSyncQuality timing={timing} />
      <span>{t("roomSyncEstimateHint")}</span>
      <span>{t("roomSyncClicksHint")}</span>
    </span>
  );

  return (
    <div className="roomTiming" role="status" aria-label={t("roomSyncResult")}>
      <div className="roomTimingHeader">
        <Typography as="span" variant="caption" tone="muted">
          {t("roomDelay")}
        </Typography>
        <Tooltip title={details}>
          <button
            type="button"
            className="roomInfoButton"
            aria-label={t("roomTimingDetails")}
          >
            <Info aria-hidden />
          </button>
        </Tooltip>
      </div>
      <Typography as="strong" variant="h4">
        {t("millisecondsValue", { value: Math.round(delayMs) })}
      </Typography>
      <Typography as="span" variant="caption" tone="muted">
        {t("roomPing")}:{" "}
        {t("millisecondsValue", { value: Math.round(timing.roundTripMs) })} ·{" "}
        {t("roomJitter")}:{" "}
        {t("millisecondsValue", { value: jitterMs.toFixed(1) })}
        {link.route && (
          <>
            {" "}· {t("roomRoute")}:{" "}
            {t(link.route === "direct" ? "roomRouteDirect" : "roomRouteRelay")}
          </>
        )}
      </Typography>
      {link.deviceStarving && (
        <Typography as="span" variant="caption" tone="danger">
          {t("roomDeviceStarving")}
        </Typography>
      )}
      {link.unstable && !link.deviceStarving && (
        <Typography as="span" variant="caption" tone="danger">
          {t("roomUnstableLink")}
        </Typography>
      )}
    </div>
  );
};
