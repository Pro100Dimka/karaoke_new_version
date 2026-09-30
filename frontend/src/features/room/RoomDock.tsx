import {
  Activity,
  Check,
  Copy,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  WifiOff,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useApp } from "../../app/AppContext";
import { useAsk } from "../../app/DialogProvider";
import { useNotify } from "../../app/NotificationsProvider";
import type { ParticipantDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { audioClient } from "../../services/audioClient";
import { desktopClient } from "../../services/desktopClient";
import { roomClient } from "../../services/roomClient";
import { errorMessageKey, toAppError } from "../../shared/errors";
import {
  Box,
  Button,
  Card,
  IconButton,
  Stack,
  Typography,
} from "../../theme/ui";
import "./room.css";
import { RoomLatencyPanel } from "./RoomLatencyPanel";
import { RoomTransferStatus } from "./RoomTransferStatus";
import { Participant } from "./RoomParticipant";
import { allowRoomProjectReplacement } from "./roomProjectDownload";
import { DetachButton, DetachedPanel } from "../../shared/ui/DetachedPanel";
import { useDetachedPanel } from "../../shared/ui/useDetachedPanel";
import { useFloatingPanel, useStoredPanelLayout } from "../../shared/ui/useFloatingPanel";
import { useRoomPeople } from "../social/useRoomPeople";

// The room panel's window starts at the size of the in-app dock.
const roomPanelSize = { width: 300, height: 640 };

export const RoomDock = () => {
  const { room, setRoom } = useApp();
  const { pathname } = useLocation();
  const ask = useAsk();
  const notify = useNotify();
  const t = useText();
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [checkingTiming, setCheckingTiming] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const isHost = room?.role === "host";
  const people = useRoomPeople(room);
  // The dock is dragged anywhere in the app by its surface, and past the window's edge into a window.
  const placement = useStoredPanelLayout("room");
  const panel = useDetachedPanel("room", t("onlineRoom"), roomPanelSize, placement.save);
  const frameRef = useRef<HTMLElement>(null);
  const floating = useFloatingPanel(frameRef, {
    layout: placement.layout, save: placement.save, defaultSize: roomPanelSize,
    onTearOff: (bounds, pointer) => panel.detach(bounds, pointer),
  });
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
      setRoom(await roomClient.startSyncCheck(room.code));
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

  if (collapsed && !panel.detached) {
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
    <DetachedPanel panel={panel}>
    <Card
      as="aside"
      variant="neon"
      tilt={false}
      className="roomDock"
      aria-label={t("onlineRoom")}
      ref={frameRef}
      style={!panel.detached && floating.layout
        ? { left: floating.layout.left, top: floating.layout.top, bottom: "auto", right: "auto" }
        : undefined}
      onPointerDown={panel.detached ? undefined : floating.beginMove}
      onPointerMove={panel.detached ? undefined : floating.handleMove}
      onPointerUp={panel.detached ? undefined : floating.handleUp}
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
            <DetachButton panel={panel} />
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
        <RoomTransferStatus
          room={room}
          onCancel={() => {
            if (room.transferId)
              void desktopClient.cancelRoomProjectTransfer(room.transferId);
          }}
          onRetry={() => void retryTransfer()}
          onReplace={() => {
            if (room.songId && room.revision !== undefined)
              allowRoomProjectReplacement(room.songId, room.revision);
            void retryTransfer();
          }}
        />
        <ul className="participants" aria-label={t("participants")}>
          {room.participants.map((participant) => (
            <Participant
              key={participant.id}
              participant={participant}
              person={people.get(participant.id)}
              hostControls={isHost}
              onTransferHost={(target) => void transferHost(target)}
              onRemove={(target) => void removeParticipant(target)}
            />
          ))}
        </ul>
        <RoomLatencyPanel />
        <div className="roomFooterActions">
          <IconButton
            size="sm"
            variant="outline"
            tone="neutral"
            icon={Activity}
            label={t("roomCheckSync")}
            disabled={checkingTiming}
            onClick={() => void checkTiming()}
          />
          <IconButton
            size="sm"
            variant="outline"
            tone="danger"
            icon={LogOut}
            label={t("leaveRoom")}
            onClick={() => void handleLeave()}
          />
        </div>
      </Stack>
    </Card>
    </DetachedPanel>
  );
};
