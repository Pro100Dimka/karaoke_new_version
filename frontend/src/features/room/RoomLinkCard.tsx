import {
  reportOperationFailure,
  clearOperationFailure,
} from '../../shared/errors';
import { monitoringErrorText } from '../../shared/errors';
import { useEffect, useRef, useState } from 'react';
import {
  Badge,
  Card,
  Icon,
  SignalBars,
  Sparkline,
  Switch,
  Tooltip,
  Typography,
  tr,
  useLocale,
} from '@neo-ui-kit/react';
import type { RoomTimingReport } from '../../contracts/clients';
import type { MessageKey } from '../../providers/localization/messages';
import { useRoomVoice } from '../../providers/application';
import { useNotify } from '../../providers/notifications';
import { roomLink, type RoomLinkState } from './roomLink';
import { roomQualityMessage, RoomSyncQuality } from './RoomSyncQuality';

// Route and stability are judged over about ten seconds, so the line does not flicker.
const linkWindowReports = 5;
// The trace shows the last two minutes of the room delay.
const traceReports = 60;

type Quality = { key: MessageKey; bars: number; bad: boolean };

const quality = (timing: RoomTimingReport, link: RoomLinkState): Quality => {
  if (link.deviceStarving) return { key: 'linkOverloaded', bars: 1, bad: true };
  if (link.unstable) return { key: 'linkUnstable', bars: 2, bad: true };
  const message = roomQualityMessage(timing);
  if (message === 'roomQualityFar')
    return { key: 'linkHigh', bars: 2, bad: true };
  return message === 'roomQualityClose'
    ? { key: 'linkExcellent', bars: 4, bad: false }
    : { key: 'linkGood', bars: 3, bad: false };
};

/** The link: room delay and how good it is, its trace, and hearing yourself (monitoring). */
export const RoomLinkCard = () => {
  useLocale();
  const notify = useNotify();
  const latest = useRef({ notify });
  latest.current = { notify };
  const voice = useRoomVoice();
  const [timing, setTiming] = useState<RoomTimingReport | null>(null);
  const [monitoring, setMonitoring] = useState(false);
  const history = useRef<RoomTimingReport[]>([]);
  const trace = useRef<number[]>([]);
  const monitoringWarningShown = useRef(false);

  useEffect(() => {
    if (!voice) return;
    let active = true;
    setMonitoring(voice.monitoringEnabled());
    const unsubscribe = voice.subscribeTiming((report) => {
      void voice
        .monitoringStatus()
        .then((snapshot) => {
          if (!active) return;
          if (
            snapshot.monitoringSafetyTripped &&
            !monitoringWarningShown.current
          ) {
            setMonitoring(false);
            monitoringWarningShown.current = true;
            latest.current.notify(tr('monitoringSafetyStopped'), 'error');
          } else if (!snapshot.monitoringSafetyTripped) {
            monitoringWarningShown.current = false;
          }
        })
        .then(() => clearOperationFailure('errors.monitoringStatus'))
        .catch((error: unknown) => {
          if (active) reportOperationFailure('errors.monitoringStatus', error);
        });
      history.current = [...history.current, report].slice(
        -(linkWindowReports + 1),
      );
      const delay =
        report.roomPlayoutDelayMs ||
        report.voiceDelayMs ||
        report.estimatedVoiceLatencyMs;
      trace.current = [...trace.current, delay].slice(-traceReports);
      setMonitoring(voice.monitoringEnabled());
      setTiming(report);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [voice]);

  const toggleMonitoring = async () => {
    if (!voice) return;
    const snapshot = await voice
      .setMonitoring(!monitoring)
      .catch((error: unknown) => {
        latest.current.notify(monitoringErrorText(error), 'error');
        return null;
      });
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
  const scheduledDelayMs = timing.roomPlayoutDelayMs || timing.voiceDelayMs;
  const delayMs = scheduledDelayMs || timing.estimatedVoiceLatencyMs;
  const rated = quality(timing, link);
  const details = (
    <span className="roomTimingDetails">
      <RoomSyncQuality timing={timing} />
      <Typography as="span" variant="caption" tone="muted">
        {tr('roomPing')}:{' '}
        {tr('millisecondsValue', { value: Math.round(timing.roundTripMs) })} ·{' '}
        {tr('roomJitter')}:{' '}
        {tr('millisecondsValue', { value: jitterMs.toFixed(1) })}
        {link.route && (
          <>
            {' '}
            · {tr('roomRoute')}:{' '}
            {tr(link.route === 'direct' ? 'roomRouteDirect' : 'roomRouteRelay')}
          </>
        )}
      </Typography>
      {link.deviceStarving && (
        <Typography as="span" variant="caption" tone="danger">
          {tr('roomDeviceStarving')}
        </Typography>
      )}
      {link.unstable && !link.deviceStarving && (
        <Typography as="span" variant="caption" tone="danger">
          {tr('roomUnstableLink')}
        </Typography>
      )}
      <span>{tr('roomSyncEstimateHint')}</span>
      <span>{tr('roomSyncClicksHint')}</span>
    </span>
  );

  return (
    <Card
      border
      padding="sm"
      className="roomLink"
      role="status"
      aria-label={tr('roomSyncResult')}
    >
      <Tooltip content={details}>
        <button
          type="button"
          className="roomLinkSignal"
          aria-label={tr('roomTimingDetails')}
        >
          <SignalBars
            level={rated.bars}
            weak={rated.bad}
            label={tr(rated.key)}
          />
        </button>
      </Tooltip>
      <div className="roomLinkDelay">
        <Typography variant="caption" tone="muted">
          {tr(
            scheduledDelayMs > 0
              ? 'roomLatencyLabel'
              : 'roomEstimatedLatencyLabel',
          )}
        </Typography>
        <Typography as="strong" variant="h3">
          {tr('millisecondsValue', { value: Math.round(delayMs) })}
        </Typography>
        <Typography variant="caption" tone="muted">
          {tr('roomPing')}:{' '}
          {timing.networkTransportRunning && timing.roundTripMs > 0
            ? tr('millisecondsValue', {
                value: Math.round(timing.roundTripMs),
              })
            : '—'}
        </Typography>
        <Badge tone={rated.bad ? 'warning' : 'success'}>{tr(rated.key)}</Badge>
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
          {tr('monitoring')}
        </Typography>
        <Switch
          aria-label={tr('monitoring')}
          checked={monitoring}
          onValueChange={() => void toggleMonitoring()}
        />
      </div>
    </Card>
  );
};
