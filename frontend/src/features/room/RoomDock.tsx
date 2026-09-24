import {
  Activity,
  Check,
  Copy,
  Crown,
  Ellipsis,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Sparkles,
  UserRoundX,
  WifiOff,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useApp } from "../../app/AppContext";
import { useAsk } from "../../app/DialogProvider";
import { useNotify } from "../../app/NotificationsProvider";
import type { RoomTimingReport } from "../../contracts/clients";
import type { ParticipantDto } from "../../contracts/models";
import type { MessageKey } from "../../i18n/messages";
import { useText } from "../../i18n/useText";
import { audioClient } from "../../services/audioClient";
import { desktopClient } from "../../services/desktopClient";
import { roomClient } from "../../services/roomClient";
import { errorMessageKey, toAppError } from "../../shared/errors";
import { ActionMenu } from "../../shared/ui/ActionMenu";
import { LiveSignalWaveform } from "../../shared/ui/LiveSignalWaveform";
import {
  Box,
  Button,
  Card,
  IconButton,
  Progress,
  RotaryKnob,
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

const participantEffectKnobs = [
  {
    id: "reverb",
    label: "participantReverb",
    min: 0,
    max: 1,
    step: 0.01,
    displayFactor: 100,
    valueSuffix: "%",
  },
  {
    id: "echo",
    label: "participantEcho",
    min: 0,
    max: 1,
    step: 0.01,
    displayFactor: 100,
    valueSuffix: "%",
  },
  {
    id: "noiseSuppression",
    label: "participantNoiseSuppression",
    min: 0,
    max: 1,
    step: 1,
    displayFactor: 100,
    valueSuffix: "%",
  },
  {
    id: "octave",
    label: "participantOctave",
    min: -1,
    max: 1,
    step: 1,
    displayFactor: 1,
    valueSuffix: "",
  },
] as const satisfies ReadonlyArray<{
  id: "reverb" | "echo" | "delay" | "noiseSuppression" | "octave";
  label: MessageKey;
  min: number;
  max: number;
  step: number;
  displayFactor: number;
  valueSuffix?: string;
}>;

const formatBytes = (bytes: number): string => {
  const units = ["B", "KB", "MB", "GB"] as const;
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
};

const Participant = ({
  participant,
  hostControls,
  onTransferHost,
  onRemove,
}: {
  participant: ParticipantDto;
  hostControls: boolean;
  onTransferHost(participant: ParticipantDto): void;
  onRemove(participant: ParticipantDto): void;
}) => {
  const t = useText();
  const roleLabel = participant.role === "host" ? t("host") : t("participant");
  const name = participant.self
    ? `${participant.name} · ${t("you")}`
    : participant.name;
  const ready = participant.readiness === "ready";
  const [effectsOpen, setEffectsOpen] = useState(false);
  const [volume, setVolume] = useState(participant.volume);
  const [effects, setEffects] = useState({
    reverb: 0,
    echo: 0,
    delay: 0,
    noiseSuppression: 0,
    octave: 0,
  });
  const updateEffect = (
    effect: "reverb" | "echo" | "delay" | "noiseSuppression" | "octave",
    value: number,
  ) => {
    setEffects((current) => ({ ...current, [effect]: value }));
    void audioClient.setParticipantEffect(participant.id, effect, value);
  };
  useEffect(() => setVolume(participant.volume), [participant.volume]);

  const toggleEffects = () => setEffectsOpen((open) => !open);
  const hostActions = [
    {
      id: "transfer",
      label: t("transferHostAction", { name: participant.name }),
      icon: <Crown size={16} />,
      run: () => onTransferHost(participant),
    },
    {
      id: "effects",
      label: t("participantEffects", { name: participant.name }),
      icon: <Sparkles size={16} />,
      run: toggleEffects,
    },
    {
      id: "remove",
      label: t("removeParticipant", { name: participant.name }),
      icon: <UserRoundX size={16} />,
      destructive: true,
      run: () => onRemove(participant),
    },
  ] as const;

  return (
    <li className="participant">
      <div className="participantMain">
        {hostControls && !participant.self && (
          <div className="participantActions">
            <ActionMenu
              iconOnly
              trigger={(triggerProps) => (
                <IconButton
                  {...triggerProps}
                  size="sm"
                  variant="outline"
                  icon={Ellipsis}
                  label={t("moreActions")}
                />
              )}
              items={hostActions}
            />
          </div>
        )}
        <div>
          <strong>
            {participant.role === "host" && (
              <Crown aria-label={t("host")} size={13} />
            )}{" "}
            {name}
          </strong>
          <LiveSignalWaveform
            compact
            active={participant.connected && !participant.muted}
            level={Math.min(1, participant.speakingLevel * 4)}
            ariaLabel={t("liveInputLevel")}
            title={participant.name}
            style={{ inlineSize: "unset" }}
          />
        </div>
        {!participant.connected && (
          <WifiOff aria-label={t("readinessDisconnected")} size={14} />
        )}
      </div>
      {!participant.self && (
        <div className="participantControls">
          <div className="participantVolume">
            <RotaryKnob
              label={t("participantVolume", { name: participant.name })}
              min={0}
              max={1}
              step={0.01}
              size="sm"
              displayFactor={100}
              valueSuffix="%"
              defaultValue={1}
              value={volume}
              onChange={(value) => {
                setVolume(value);
                void audioClient.setParticipantVolume(participant.id, value);
              }}
            />
            {!hostControls && (
              <IconButton
                size="sm"
                variant="outline"
                icon={Sparkles}
                label={t("participantEffects", { name: participant.name })}
                onClick={toggleEffects}
              />
            )}
          </div>
          {effectsOpen && (
            <div className="participantEffects">
              <div className="participantEffectKnobs">
                {participantEffectKnobs.map((effect) => (
                  <RotaryKnob
                    key={effect.id}
                    label={t(effect.label)}
                    min={effect.min}
                    max={effect.max}
                    step={effect.step}
                    size="sm"
                    displayFactor={effect.displayFactor}
                    valueSuffix={effect.valueSuffix}
                    defaultValue={0}
                    value={effects[effect.id]}
                    onChange={(value) => updateEffect(effect.id, value)}
                  />
                ))}
              </div>
            </div>
          )}
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
          { id: "close", label: t("closeRoom"), appearance: "secondary" },
        ],
      });
      if (choice === "cancel" || choice === null) return;
      if (choice === "close") {
        try {
          await roomClient.closeRoom(room.code);
        } catch (error) {
          failure(error);
          return;
        }
        await audioClient.leaveVoiceSession().catch(() => undefined);
        setRoom(null);
        return;
      }
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

  const transferHost = async (participant: ParticipantDto) => {
    try {
      setRoom(await roomClient.transferHost(room.code, participant.id));
    } catch (error) {
      failure(error);
    }
  };

  const removeParticipant = async (participant: ParticipantDto) => {
    const choice = await ask({
      title: t("removeParticipantTitle"),
      body: t("removeParticipantBody", { name: participant.name }),
      tone: "warning",
      actions: [
        { id: "cancel", label: t("cancel") },
        {
          id: "remove",
          label: t("removeParticipant", { name: participant.name }),
          appearance: "primary",
        },
      ],
    });
    if (choice !== "remove") return;
    try {
      const updated = await roomClient.removeParticipant(
        room.code,
        participant.id,
      );
      await audioClient
        .removeRemoteParticipant(participant.id)
        .catch(() => undefined);
      setRoom(updated);
    } catch (error) {
      failure(error);
    }
  };

  const checkTiming = async () => {
    setCheckingTiming(true);
    try {
      const [updated, report] = await Promise.all([
        roomClient.startSyncCheck(room.code),
        audioClient.roomTiming(),
      ]);
      setRoom(updated);
      setTiming(report);
    } catch (error) {
      failure(error);
    } finally {
      setCheckingTiming(false);
    }
  };

  const retryTransfer = async () => {
    try {
      setRoom(await roomClient.setRoomReadiness(room.code, "MissingSong"));
    } catch (error) {
      failure(error);
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
        {room.connectionStatus === "reconnecting" && (
          <div
            className="roomConnectionStatus"
            role="status"
            aria-label={t("roomReconnecting")}
          >
            <WifiOff aria-hidden size={14} />
            <Typography as="span" variant="caption">
              {t("roomReconnecting")}
            </Typography>
          </div>
        )}
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
            {room.transferTotalBytes !== undefined && (
              <Typography as="span" variant="caption" tone="muted">
                {formatBytes(room.transferBytes ?? 0)} /{" "}
                {formatBytes(room.transferTotalBytes)}
              </Typography>
            )}
            {room.transferId && !room.transferError && (
              <Button
                size="sm"
                variant="outlined"
                startIcon={<X size={14} />}
                onClick={() =>
                  room.transferId &&
                  void desktopClient.cancelRoomProjectTransfer(room.transferId)
                }
              >
                {t("cancelTransfer")}
              </Button>
            )}
            {room.transferError && (
              <Button
                size="sm"
                variant="outlined"
                startIcon={<RefreshCw size={14} />}
                onClick={() => void retryTransfer()}
              >
                {t("retryTransfer")}
              </Button>
            )}
          </div>
        )}
        <ul className="participants" aria-label={t("participants")}>
          {room.participants.map((participant) => (
            <Participant
              key={participant.id}
              participant={participant}
              hostControls={isHost}
              onTransferHost={(target) => void transferHost(target)}
              onRemove={(target) => void removeParticipant(target)}
            />
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
          <div
            className="roomTiming"
            role="status"
            aria-label={t("roomSyncResult")}
          >
            <Typography as="strong" variant="h4">
              {Math.round(timing.estimatedVoiceLatencyMs)} ms
            </Typography>
            <Typography as="span" variant="caption" tone="muted">
              RTT {Math.round(timing.roundTripMs)} ms · jitter{" "}
              {Math.max(
                0,
                ...Object.values(timing.remotes).map(
                  (remote) => remote.jitterMs,
                ),
              ).toFixed(1)}{" "}
              ms
            </Typography>
            <Typography as="span" variant="caption" tone="muted">
              {t("roomSyncEstimateHint")}
            </Typography>
            <Typography as="span" variant="caption" tone="muted">
              {t("roomSyncClicksHint")}
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
