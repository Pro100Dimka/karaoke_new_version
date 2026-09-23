import {
  Check,
  Activity,
  Copy,
  Crown,
  LogOut,
  Mic,
  MicOff,
  PanelLeftClose,
  PanelLeftOpen,
  UserRoundCheck,
  Volume2,
  WifiOff,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useApp } from "../../app/AppContext";
import { useAsk } from "../../app/DialogProvider";
import { useNotify } from "../../app/NotificationsProvider";
import type { ParticipantDto } from "../../contracts/models";
import type { RoomTimingReport } from "../../contracts/clients";
import type { MessageKey } from "../../i18n/messages";
import { useText } from "../../i18n/useText";
import { audioClient } from "../../services/audioClient";
import { desktopClient } from "../../services/desktopClient";
import { roomClient } from "../../services/roomClient";
import { errorMessageKey, toAppError } from "../../shared/errors";
import { LiveSignalWaveform } from "../../shared/ui/LiveSignalWaveform";
import {
  Box,
  Button,
  Card,
  IconButton,
  Progress,
  Slider,
  Stack,
  Typography,
} from "../../theme/ui";
import "./room.css";

const readinessLabels = {
  missing: "readinessMissing",
  preparing: "readinessPreparing",
  downloading: "readinessDownloading",
  verifying: "readinessVerifying",
  audio: "readinessAudio",
  ready: "readinessReady",
  failed: "readinessFailed",
  disconnected: "readinessDisconnected",
} satisfies Record<ParticipantDto["readiness"], MessageKey>;

const Participant = ({ participant }: { participant: ParticipantDto }) => {
  const t = useText();
  const roleLabel = participant.role === "host" ? t("host") : t("participant");
  const name = participant.self
    ? `${participant.name} · ${t("you")}`
    : participant.name;
  const ready = participant.readiness === "ready";

  return (
    <li className="participant">
      <div className="participantMain">
        {participant.muted ? (
          <MicOff aria-hidden size={15} />
        ) : (
          <Mic aria-hidden size={15} />
        )}
        <div>
          <strong>
            {participant.role === "host" && (
              <Crown aria-label={t("host")} size={13} />
            )}{" "}
            {name}
          </strong>
          <span>
            {roleLabel} · {t(readinessLabels[participant.readiness])}
          </span>
        </div>
        {!participant.connected && (
          <WifiOff aria-label={t("readinessDisconnected")} size={14} />
        )}
        {ready && participant.connected && (
          <UserRoundCheck aria-label={t("readinessReady")} size={14} />
        )}
        <LiveSignalWaveform
          compact
          active={participant.connected && !participant.muted}
          level={Math.min(1, participant.speakingLevel * 4)}
          ariaLabel={t("liveInputLevel")}
          title={participant.name}
        />
      </div>
      {!participant.self && (
        <div className="participantVolume">
          <Volume2 aria-hidden size={14} />
          <Slider
            aria-label={t("participantVolume", { name: participant.name })}
            min={0}
            max={1}
            step={0.01}
            defaultValue={participant.volume}
            showValue={false}
            onChange={(value) =>
              void audioClient.setParticipantVolume(participant.id, value)
            }
          />
        </div>
      )}
    </li>
  );
};

export const RoomDock = () => {
  const { room, setRoom } = useApp();
  const { pathname } = useLocation();
  const ask = useAsk();
  const notify = useNotify();
  const t = useText();
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [timing, setTiming] = useState<RoomTimingReport | null>(null);
  const [checkingTiming, setCheckingTiming] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const isHost = room?.role === "host";
  // The dock stays out of the way while the Melody Editor owns the screen.
  if (!room || pathname.startsWith("/editor/")) return null;

  const failure = (error: unknown) =>
    notify(
      t(errorMessageKey(toAppError(error)) ?? "roomNetworkUnavailable"),
      "error",
    );

  const handleCopy = async () => {
    await desktopClient.copyText(room.code);
    setCopied(true);
  };

  const handleLeave = async () => {
    const others = room.participants.filter((person) => !person.self).length;
    if (isHost && others > 0) {
      const choice = await ask({
        title: t("hostLeavingTitle"),
        body: t("hostLeavingBody"),
        actions: [
          { id: "cancel", label: t("cancel") },
          { id: "transfer", label: t("transferHost"), appearance: "primary" },
        ],
      });
      if (choice !== "transfer") return;
    }
    try {
      await roomClient.leaveRoom(room.code);
    } catch (error) {
      failure(error);
    }
    await audioClient.leaveVoiceSession().catch(() => undefined);
    setRoom(null);
  };

  const checkTiming = async () => {
    setCheckingTiming(true);
    try {
      setTiming(await audioClient.roomTiming());
    } catch (error) {
      failure(error);
    } finally {
      setCheckingTiming(false);
    }
  };

  const collapseLabel = t(collapsed ? "expandRoom" : "collapseRoom");
  const roomRole = isHost ? t("host") : t("participant");

  if (collapsed) {
    return (
      <Box className="roomDockCollapsed">
        <Button
          variant="outlined"
          startIcon={<PanelLeftOpen />}
          aria-label={collapseLabel}
          onClick={() => setCollapsed(false)}
        >
          {room.code}
        </Button>
      </Box>
    );
  }

  return (
    <Card
      as="aside"
      variant="neon"
      tilt={false}
      className="roomDock"
      aria-label={t("onlineRoom")}
    >
      <Stack gap="var(--space-3)" className="roomDockContent">
        <header className="roomDockHeader">
          <Stack
            direction="row"
            align="center"
            gap="var(--space-2)"
            className="roomDockCodeActions"
          >
            <IconButton
              size="sm"
              variant="outline"
              icon={PanelLeftClose}
              label={collapseLabel}
              onClick={() => setCollapsed(true)}
            />
            <Typography as="strong">{room.code}</Typography>
            <IconButton
              size="sm"
              variant="outline"
              icon={copied ? Check : Copy}
              label={t(copied ? "copied" : "copyCode")}
              onClick={() => void handleCopy()}
            />
          </Stack>
        </header>
        {room.transferProgress !== undefined && (
          <div className="transfer">
            <Typography as="span" variant="caption" tone="muted">
              {t("projectTransfer", { progress: room.transferProgress })}
            </Typography>
            <Progress
              aria-label={t("projectTransfer", {
                progress: room.transferProgress,
              })}
              value={room.transferProgress}
            />
          </div>
        )}
        <ul className="participants" aria-label={t("participants")}>
          {room.participants.map((participant) => (
            <Participant key={participant.id} participant={participant} />
          ))}
        </ul>
        <Button
          variant="outlined"
          tone="neutral"
          startIcon={<Activity size={16} />}
          disabled={checkingTiming}
          onClick={() => void checkTiming()}
        >
          {t("roomCheckSync")}
        </Button>
        {timing && (
          <div className="roomTiming" role="status" aria-label={t("roomSyncResult")}>
            <Typography as="strong" variant="h4">
              {Math.round(timing.estimatedVoiceLatencyMs)} ms
            </Typography>
            <Typography as="span" variant="caption" tone="muted">
              RTT {Math.round(timing.roundTripMs)} ms · jitter {Math.max(0, ...Object.values(timing.remotes).map(remote => remote.jitterMs)).toFixed(1)} ms
            </Typography>
            <Typography as="span" variant="caption" tone="muted">
              {t("roomSyncEstimateHint")}
            </Typography>
          </div>
        )}
        <Button
          variant="outlined"
          tone="neutral"
          startIcon={<LogOut size={16} />}
          onClick={() => void handleLeave()}
        >
          {t("leaveRoom")}
        </Button>
      </Stack>
    </Card>
  );
};
