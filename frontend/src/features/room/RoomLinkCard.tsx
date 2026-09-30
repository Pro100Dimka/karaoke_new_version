import { useEffect, useRef, useState } from "react";
import type { RoomTimingReport } from "../../contracts/clients";
import type { MessageKey } from "../../i18n/messages";
import { useText } from "../../i18n/useText";
import { audioClient } from "../../services/audioClient";
import { Tooltip, Typography } from "../../theme/ui";
import { HeadphonesIcon } from "./HeadphonesIcon";
import { roomLink, type RoomLinkState } from "./roomLink";
import { roomQualityMessage, RoomSyncQuality } from "./RoomSyncQuality";
import { RoomSurface } from "./RoomSurface";

const refreshMilliseconds = 2_000;
// Route and stability are judged over about ten seconds, so the line does not flicker.
const linkWindowReports = 5;
// The trace shows the last two minutes of the room delay.
const traceReports = 60;
const traceWidth = 293;
const traceHeight = 80;

type Quality = { key: MessageKey; bars: number; bad: boolean };

const quality = (timing: RoomTimingReport, link: RoomLinkState): Quality => {
  if (link.deviceStarving) return { key: "linkOverloaded", bars: 1, bad: true };
  if (link.unstable) return { key: "linkUnstable", bars: 2, bad: true };
  const message = roomQualityMessage(timing);
  if (message === "roomQualityFar") return { key: "linkHigh", bars: 2, bad: true };
  return message === "roomQualityClose" ? { key: "linkExcellent", bars: 4, bad: false } : { key: "linkGood", bars: 3, bad: false };
};

/** The room delay over time as a line: its own range fills the height, so every change shows. */
const tracePath = (values: number[]): string => {
  if (values.length < 2) return "";
  const low = Math.min(...values);
  const range = Math.max(...values) - low;
  // A steady delay is a flat line through the middle; any change then fills the height.
  const span = range > 0 ? range : 1;
  const middle = range > 0 ? 0 : 0.5;
  const step = traceWidth / (traceReports - 1);
  const start = traceWidth - step * (values.length - 1);
  return values
    .map((value, index) => `${index ? "L" : "M"}${(start + index * step).toFixed(1)},${(traceHeight - 6 - (middle + (value - low) / span) * (traceHeight - 12)).toFixed(1)}`)
    .join(" ");
};

/** The link: room delay and how good it is, its trace, and hearing yourself (monitoring). */
export const RoomLinkCard = () => {
  const t = useText();
  const [timing, setTiming] = useState<RoomTimingReport | null>(null);
  const [monitoring, setMonitoring] = useState(audioClient.monitoringEnabled());
  const history = useRef<RoomTimingReport[]>([]);
  const trace = useRef<number[]>([]);
  // The last real room delay: a moment without voices must not swap it for the rough estimate.
  const lastVoiceDelayMs = useRef(0);

  useEffect(() => {
    let active = true;
    const refresh = () => void audioClient.roomTiming().then(report => {
      if (!active) return;
      history.current = [...history.current, report].slice(-(linkWindowReports + 1));
      if (report.voiceDelayMs > 0) lastVoiceDelayMs.current = report.voiceDelayMs;
      const delay = lastVoiceDelayMs.current || report.estimatedVoiceLatencyMs;
      trace.current = [...trace.current, delay].slice(-traceReports);
      setMonitoring(audioClient.monitoringEnabled());
      setTiming(report);
    }, () => undefined);
    refresh();
    const timer = window.setInterval(refresh, refreshMilliseconds);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const toggleMonitoring = async () => {
    const snapshot = await audioClient.setMonitoring(!monitoring).catch(() => null);
    if (snapshot) setMonitoring(snapshot.monitoring);
  };

  if (!timing) return null;
  const link = roomLink(history.current.length > 1 ? history.current[0] : undefined, timing);
  const jitterMs = Math.max(0, ...Object.values(timing.remotes).map(remote => remote.jitterMs));
  const delayMs = lastVoiceDelayMs.current > 0 ? lastVoiceDelayMs.current : timing.estimatedVoiceLatencyMs;
  const rated = quality(timing, link);
  const details = (
    <span className="roomTimingDetails">
      <RoomSyncQuality timing={timing} />
      <Typography as="span" variant="caption" tone="muted">
        {t("roomPing")}: {t("millisecondsValue", { value: Math.round(timing.roundTripMs) })} · {t("roomJitter")}:{" "}
        {t("millisecondsValue", { value: jitterMs.toFixed(1) })}
        {link.route && <> · {t("roomRoute")}: {t(link.route === "direct" ? "roomRouteDirect" : "roomRouteRelay")}</>}
      </Typography>
      {link.deviceStarving && <Typography as="span" variant="caption" tone="danger">{t("roomDeviceStarving")}</Typography>}
      {link.unstable && !link.deviceStarving && <Typography as="span" variant="caption" tone="danger">{t("roomUnstableLink")}</Typography>}
      <span>{t("roomSyncEstimateHint")}</span>
      <span>{t("roomSyncClicksHint")}</span>
    </span>
  );

  return (
    <section className="roomCard roomCard--warm roomLink" role="status" aria-label={t("roomSyncResult")}>
      <RoomSurface variant="network" />
      <Tooltip title={details}>
        <button type="button" className="roomTile" aria-label={t("roomTimingDetails")}>
          <span className="roomSignal" aria-hidden>
            {[18, 30, 42, 56].map((height, index) => (
              <i key={height} data-lit={index < rated.bars} style={{ blockSize: `calc(${height} * var(--u))` }} />
            ))}
          </span>
        </button>
      </Tooltip>
      <div className="roomLinkDelay">
        <span className="roomLinkLabel">{t("roomLatencyLabel")}</span>
        <strong className="roomLinkValue">{t("millisecondsValue", { value: Math.round(delayMs) })}</strong>
        <span className="roomQuality" data-quality={rated.bad ? "bad" : "good"}>{t(rated.key)}</span>
      </div>
      <span className="roomSeparator roomSeparator--delay" aria-hidden />
      <svg className="roomTrace" viewBox={`0 0 ${traceWidth} ${traceHeight}`} preserveAspectRatio="none" aria-hidden>
        {[0.25, 0.5, 0.75].map(y => <line key={y} className="roomTraceGrid" x1={0} x2={traceWidth} y1={traceHeight * y} y2={traceHeight * y} />)}
        {[0.2, 0.4, 0.6, 0.8].map(x => <line key={x} className="roomTraceGrid" x1={traceWidth * x} x2={traceWidth * x} y1={0} y2={traceHeight} />)}
        <path className="roomTraceLine" d={tracePath(trace.current)} />
      </svg>
      <span className="roomSeparator roomSeparator--trace" aria-hidden />
      <span className="roomTile roomTile--monitor" aria-hidden><HeadphonesIcon /></span>
      <div className="roomMonitor">
        <span className="roomLinkLabel">{t("monitoring")}</span>
        <button type="button" role="switch" className="roomToggle" aria-checked={monitoring} aria-label={t("monitoring")}
          onClick={() => void toggleMonitoring()}>
          <i />
        </button>
      </div>
    </section>
  );
};
