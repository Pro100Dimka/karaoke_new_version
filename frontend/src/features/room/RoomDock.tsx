import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useApp } from "../../app/AppContext";
import { useAsk } from "../../app/DialogProvider";
import { useNotify } from "../../app/NotificationsProvider";
import type { ParticipantDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { audioClient } from "../../services/audioClient";
import { desktopClient } from "../../services/desktopClient";
import { pythonClient } from "../../services/pythonClient";
import { roomClient } from "../../services/roomClient";
import { errorMessageKey, toAppError } from "../../shared/errors";
import { Button } from "@ad-voice/ui";
import "./room-dock.css";
import { RoomHeadCard } from "./RoomHeadCard";
import { RoomLinkCard } from "./RoomLinkCard";
import { RoomPersonCard } from "./RoomPersonCard";
import { allowRoomProjectReplacement } from "./roomProjectDownload";
import { DetachButton, DetachedPanel } from "../../shared/ui/DetachedPanel";
import { useDetachedPanel } from "../../shared/ui/useDetachedPanel";
import { useFloatingPanel, useStoredPanelLayout } from "../../shared/ui/useFloatingPanel";
import { useRoomPeople } from "../social/useRoomPeople";

// The room panel's window starts at the size of the in-app dock.
const roomPanelSize = { width: 555, height: 660 };

export const RoomDock = () => {
  const { room, setRoom } = useApp();
  const { pathname } = useLocation();
  const ask = useAsk();
  const notify = useNotify();
  const t = useText();
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [checkingTiming, setCheckingTiming] = useState(false);
  const [selectedSongArtwork, setSelectedSongArtwork] = useState<{ songId: string; title: string; url: string }>();

  const selectedTransferReady = room?.transferProgress === undefined || room.transferProgress >= 100;
  useEffect(() => {
    let active = true;
    if (!room?.songId) {
      setSelectedSongArtwork(undefined);
      return () => { active = false; };
    }
    void pythonClient.listSongs()
      .then(songs => {
        if (!active) return;
        const selected = songs.find(song => song.id === room.songId && song.artworkUrl);
        setSelectedSongArtwork(selected?.artworkUrl
          ? { songId: selected.id, title: selected.title, url: selected.artworkUrl }
          : undefined);
      })
      .catch(() => {
        if (active) setSelectedSongArtwork(undefined);
      });
    return () => { active = false; };
  }, [room?.songId, room?.revision, selectedTransferReady]);

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
    layout: placement.layout, onLayoutChange: placement.save, defaultSize: roomPanelSize,
    onDragOutside: (bounds, pointer) => panel.detach(bounds, pointer),
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

  if (collapsed && !panel.detached) {
    return (
      <div className="roomDockCollapsed">
        <Button icon="window" aria-label={collapseLabel} onClick={() => setCollapsed(false)}>
          {room.code}
        </Button>
      </div>
    );
  }

  const cancelTransfer = () => {
    if (room.transferId) void desktopClient.cancelRoomProjectTransfer(room.transferId);
  };
  const replaceProject = () => {
    if (room.songId && room.revision !== undefined) allowRoomProjectReplacement(room.songId, room.revision);
    void retryTransfer();
  };

  return (
    <DetachedPanel panel={panel}>
      <aside
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
        <RoomHeadCard
          room={room}
          artwork={selectedSongArtwork?.songId === room.songId ? selectedSongArtwork : undefined}
          actions={{
            copied,
            checkingSync: checkingTiming,
            detached: panel.detached,
            onCopy: () => void handleCopy(),
            onCollapse: () => setCollapsed(true),
            onCheckSync: () => void checkTiming(),
            onDetach: () => panel.detach(),
            onAttach: panel.attach,
            onCancelTransfer: cancelTransfer,
            onRetryTransfer: () => void retryTransfer(),
            onReplaceProject: replaceProject,
            onLeave: () => void handleLeave(),
          }}
        />
        <ul className="roomPeople" aria-label={t("participants")}>
          {room.participants.map((participant) => (
            <RoomPersonCard
              key={participant.id}
              participant={participant}
              person={people.get(participant.id)}
              hostControls={isHost}
              onTransferHost={(target) => void transferHost(target)}
              onRemove={(target) => void removeParticipant(target)}
            />
          ))}
        </ul>
        <RoomLinkCard />
      </aside>
    </DetachedPanel>
  );
};
