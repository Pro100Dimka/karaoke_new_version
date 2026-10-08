import { useEffect, useRef, useState } from "react";
import {
  Badge,
  Card,
  Icon,
  SignalBars,
  Sparkline,
  Switch,
  Tooltip,
  Typography,
} from "@ad-voice/ui";
import type { RoomTimingReport } from "../../contracts/clients";
import type { MessageKey } from "../../i18n/messages";
import { useText } from "../../i18n/useText";
import { useRoomVoice } from "../../app/AppContext";
import { useNotify } from "../../app/NotificationsProvider";
import { roomLink, type RoomLinkState } from "./roomLink";
import { roomQualityMessage, RoomSyncQuality } from "./RoomSyncQuality";

// Route and stability are judged over about ten seconds, so the line does not flicker.
const linkWindowReports = 5;
// The trace shows the last two minutes of the room delay.
const traceReports = 60;

type Quality = { key: MessageKey; bars: number; bad: boolean };

const quality = (timing: RoomTimingReport, link: RoomLinkState): Quality => {
  if (link.deviceStarving) return { key: "linkOverloaded", bars: 1, bad: true };
  if (link.unstable) return { key: "linkUnstable", bars: 2, bad: true };
  const message = roomQualityMessage(timing);
  if (message === "roomQualityFar")
    return { key: "linkHigh", bars: 2, bad: true };
  return message === "roomQualityClose"
    ? { key: "linkExcellent", bars: 4, bad: false }
    : { key: "linkGood", bars: 3, bad: false };
};

/** The link: room delay and how good it is, its trace, and hearing yourself (monitoring). */
export const RoomLinkCard = () => {
  const t = useText();
  const notify = useNotify();
  const latest = useRef({ notify, t });
  latest.current = { notify, t };
  const voice = useRoomVoice();
  const [timing, setTiming] = useState<RoomTimingReport | null>(null);
  const [monitoring, setMonitoring] = useState(false);
  const history = useRef<RoomTimingReport[]>([]);
  const trace = useRef<number[]>([]);
  const monitoringWarningShown = useRef(false);
  // The last real room delay: a moment without voices must not swap it for the rough estimate.
  const lastVoiceDelayMs = useRef(0);

  useEffect(() => {
    if (!voice) return;
    let active = true;
    setMonitoring(voice.monitoringEnabled());
    const unsubscribe = voice.subscribeTiming((report) => {
      void voice.monitoringStatus().then((snapshot) => {
        if (!active) return;
        if (snapshot.monitoringSafetyTripped && !monitoringWarningShown.current) {
          setMonitoring(false);
          monitoringWarningShown.current = true;
          latest.current.notify(latest.current.t("monitoringSafetyStopped"), "error");
        } else if (!snapshot.monitoringSafetyTripped) {
          monitoringWarningShown.current = false;
        }
      }).catch(() => undefined);
      history.current = [...history.current, report].slice(-(linkWindowReports + 1));
      if (report.voiceDelayMs > 0)
        lastVoiceDelayMs.current = report.voiceDelayMs;
      const delay = lastVoiceDelayMs.current || report.estimatedVoiceLatencyMs;
      trace.current = [...trace.current, delay].slice(-traceReports);
      setMonitoring(voice.monitoringEnabled());
      setTiming(report);
    });
    return () => { active = false; unsubscribe(); };
  }, [voice]);

  const toggleMonitoring = async () => {
    if (!voice) return;
    const snapshot = await voice
      .setMonitoring(!monitoring)
      .catch(() => null);
    if (snapshot) setMonitoring(snapshot.monitoring);
  };

  if (!timing) return null;
  const link = roomLink(
    history.current.length > 1 ? history.current[0] : undefined,
    timing,
  );
  const jitterMs = Math.max(
    0,
    ...Object.values(timing.remotes).map((remote) => remote.jitterMs),
  );
  const delayMs =
    lastVoiceDelayMs.current > 0
      ? lastVoiceDelayMs.current
      : timing.estimatedVoiceLatencyMs;
  const rated = quality(timing, link);
  const details = (
    <span className="roomTimingDetails">
      <RoomSyncQuality timing={timing} />
      <Typography as="span" variant="caption" tone="muted">
        {t("roomPing")}:{" "}
        {t("millisecondsValue", { value: Math.round(timing.roundTripMs) })} ·{" "}
        {t("roomJitter")}:{" "}
        {t("millisecondsValue", { value: jitterMs.toFixed(1) })}
        {link.route && (
          <>
            {" "}
            · {t("roomRoute")}:{" "}
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
      <span>{t("roomSyncEstimateHint")}</span>
      <span>{t("roomSyncClicksHint")}</span>
    </span>
  );

  return (
    <Card
      border
      padding="sm"
      className="roomLink"
      role="status"
      aria-label={t("roomSyncResult")}
    >
      <Tooltip content={details}>
        <button
          type="button"
          className="roomLinkSignal"
          aria-label={t("roomTimingDetails")}
        >
          <SignalBars
            level={rated.bars}
            weak={rated.bad}
            label={t(rated.key)}
          />
        </button>
      </Tooltip>
      <div className="roomLinkDelay">
        <Typography variant="caption" tone="muted">
          {t("roomLatencyLabel")}
        </Typography>
        <Typography as="strong" variant="h3">
          {t("millisecondsValue", { value: Math.round(delayMs) })}
        </Typography>
        <Badge tone={rated.bad ? "warning" : "success"}>{t(rated.key)}</Badge>
      </div>
      <Sparkline
        fit
        className="roomLinkTrace"
        values={trace.current.length > 1 ? trace.current : [delayMs, delayMs]}
      />
      <div className="roomLinkMonitor">
        <Typography
          variant="caption"
          tone="muted"
          className="roomLinkMonitorLabel"
        >
          <Icon name="headphones" />
          {t("monitoring")}
        </Typography>
        <Switch
          aria-label={t("monitoring")}
          checked={monitoring}
          onValueChange={() => void toggleMonitoring()}
        />
      </div>
    </Card>
  );
};
