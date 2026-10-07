import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useApp, useRoomMembership, useRoomRuntime, useRoomSession } from "../../app/AppContext";
import { useAsk } from "../../app/DialogProvider";
import { useNotify } from "../../app/NotificationsProvider";
import type { ParticipantDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { errorMessageKey, toAppError } from "../../shared/errors";
import { Button } from "@ad-voice/ui";
import "./room-dock.css";
import { RoomHeadCard } from "./RoomHeadCard";
import { RoomLinkCard } from "./RoomLinkCard";
import { RoomPersonCard } from "./RoomPersonCard";
import { DetachedPanel } from "../../shared/ui/DetachedPanel";
import { useDetachedPanel } from "../../shared/ui/useDetachedPanel";
import {
  useFloatingPanel,
  useStoredPanelLayout,
} from "../../shared/ui/useFloatingPanel";
import { useRoomPeople } from "../social/useRoomPeople";

// The room panel's window starts at the size of the in-app dock.
const roomPanelSize = { width: 555, height: 660 };

export const RoomDock = () => {
  const { room } = useApp("room");
  const roomSession = useRoomSession();
  const membership = useRoomMembership();
  const runtime = useRoomRuntime();
  const { pathname } = useLocation();
  const ask = useAsk();
  const notify = useNotify();
  const t = useText();
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [checkingTiming, setCheckingTiming] = useState(false);
  const [selectedSongArtwork, setSelectedSongArtwork] = useState<{
    songId: string;
    title: string;
    url: string;
  }>();

  const selectedTransferReady =
    room?.transferProgress === undefined || room.transferProgress >= 100;
  useEffect(() => {
    let active = true;
    if (!room?.songId) {
      setSelectedSongArtwork(undefined);
      return () => {
        active = false;
      };
    }
    void runtime.getProject()
      ?.selectedArtwork()
      .then((selected) => {
        if (!active) return;
        setSelectedSongArtwork(selected);
      })
      .catch(() => {
        if (active) setSelectedSongArtwork(undefined);
      });
    return () => {
      active = false;
    };
  }, [room?.songId, room?.revision, selectedTransferReady, runtime]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const isHost = room?.role === "host";
  const people = useRoomPeople(room);
  // The dock is dragged anywhere in the app by its surface, and past the window's edge into a window.
  const placement = useStoredPanelLayout("room");
  const panel = useDetachedPanel(
    "room",
    t("onlineRoom"),
    roomPanelSize,
    placement.save,
  );
  const frameRef = useRef<HTMLElement>(null);
  const floating = useFloatingPanel(frameRef, {
    layout: placement.layout,
    onLayoutChange: placement.save,
    defaultSize: roomPanelSize,
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
    await membership?.copyInvite();
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
          await roomSession.close();
        } catch (error) {
          failure(error);
        }
        return;
      }
      if (choice !== "transfer") return;
    }
    try {
      await roomSession.leave();
    } catch (error) {
      failure(error);
    }
  };

  const transferHost = async (participant: ParticipantDto) => {
    try {
      await membership?.transferHost(participant.id);
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
      await membership?.removeParticipant(participant.id);
    } catch (error) {
      failure(error);
    }
  };

  const checkTiming = async () => {
    setCheckingTiming(true);
    try {
      await membership?.checkTiming();
    } catch (error) {
      failure(error);
    } finally {
      setCheckingTiming(false);
    }
  };

  const retryTransfer = async () => {
    try {
      await runtime.getProject()?.retry();
    } catch (error) {
      failure(error);
    }
  };

  const collapseLabel = t(collapsed ? "expandRoom" : "collapseRoom");

  if (collapsed && !panel.detached) {
    return (
      <div className="roomDockCollapsed">
        <Button
          icon="window"
          aria-label={collapseLabel}
          onClick={() => setCollapsed(false)}
        >
          {room.code}
        </Button>
      </div>
    );
  }

  const cancelTransfer = () => {
    runtime.getProject()?.cancelTransfer();
  };
  const replaceProject = () => {
    void runtime.getProject()?.replaceProject().catch(failure);
  };

  return (
    <DetachedPanel panel={panel}>
      <aside
        className="roomDock"
        aria-label={t("onlineRoom")}
        ref={frameRef}
        style={
          !panel.detached && floating.layout
            ? {
                left: floating.layout.left,
                top: floating.layout.top,
                bottom: "auto",
                right: "auto",
              }
            : undefined
        }
        onPointerDown={panel.detached ? undefined : floating.beginMove}
        onPointerMove={panel.detached ? undefined : floating.handleMove}
        onPointerUp={panel.detached ? undefined : floating.handleUp}
      >
        <RoomHeadCard
          room={room}
          artwork={
            selectedSongArtwork?.songId === room.songId
              ? selectedSongArtwork
              : undefined
          }
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
