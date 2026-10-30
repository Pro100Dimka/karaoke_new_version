import { store } from "../../providers/store";
import { useEffect, useRef, useState } from "react";
import { useRouter, Button, tr, useLocale } from "@neo-ui-kit/react";
import { useRoomMembership, roomSession, getRoomRuntime } from "../../providers/application";
import { ask } from "../../providers/dialog";
import { useNotify } from "../../providers/notifications";
import type { ParticipantDto } from "../../contracts/models";
import { ru } from "../../i18n/messages.ru";
import { errorMessageKey, toAppError } from "../../shared/errors";

import "./room-dock.css";
import { RoomHeadCard } from "./RoomHeadCard";
import { RoomLinkCard } from "./RoomLinkCard";
import { RoomPersonCard } from "./RoomPersonCard";
import { DetachedPanel } from "../../shared/ui/DetachedPanel";
import { useDetachedPanel } from "../../shared/ui/useDetachedPanel";
import {
  useFloatingPanel,
  useMeasuredPanelSize,
  useStoredPanelLayout,
} from "../../shared/ui/useFloatingPanel";
import { useRoomPeople } from "../social/useRoomPeople";

// The room panel's window starts at the size of the in-app dock.
const roomPanelSize = { width: 555, height: 660 };

export const RoomDock = () => {
  const { room } = store.online;
  const membership = useRoomMembership();
  const runtime = getRoomRuntime();
  const { pathname } = useRouter();
  const notify = useNotify();
  useLocale();
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
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
    void runtime
      .getProject()
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
    tr(ru.onlineRoom),
    roomPanelSize,
    placement.save,
  );
  const frameRef = useRef<HTMLElement>(null);
  const measuredSize = useMeasuredPanelSize(frameRef, roomPanelSize, Boolean(room) && !collapsed && !panel.detached);
  const floating = useFloatingPanel(frameRef, {
    layout: placement.layout && { ...placement.layout, ...measuredSize },
    onLayoutChange: placement.save,
    defaultSize: measuredSize,
    onDragOutside: (bounds, pointer) => panel.detach(bounds, pointer),
  });
  // The dock stays out of the way while the Melody Editor owns the screen.
  if (!room || pathname.startsWith("/editor/")) return null;

  const failure = (error: unknown) =>
    notify(
      tr(ru[errorMessageKey(toAppError(error)) ?? "roomNetworkUnavailable"]),
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
        title: tr(ru.hostLeavingTitle),
        body: tr(ru.hostLeavingBody),
        actions: [
          { id: "cancel", label: tr(ru.cancel) },
          { id: "transfer", label: tr(ru.transferHost), appearance: "primary" },
          { id: "close", label: tr(ru.closeRoom), appearance: "secondary" },
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
      title: tr(ru.removeParticipantTitle),
      body: tr(ru.removeParticipantBody, { name: participant.name }),
      tone: "warning",
      actions: [
        { id: "cancel", label: tr(ru.cancel) },
        {
          id: "remove",
          label: tr(ru.removeParticipant, { name: participant.name }),
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

  const retryTransfer = async () => {
    try {
      await runtime.getProject()?.retry();
    } catch (error) {
      failure(error);
    }
  };

  const collapseLabel = tr(ru[collapsed ? "expandRoom" : "collapseRoom"]);

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
        aria-label={tr(ru.onlineRoom)}
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
            detached: panel.detached,
            onCopy: () => void handleCopy(),
            onCollapse: () => setCollapsed(true),
            onCancelTransfer: cancelTransfer,
            onRetryTransfer: () => void retryTransfer(),
            onReplaceProject: replaceProject,
            onLeave: () => void handleLeave(),
          }}
        />
        <ul className="roomPeople" aria-label={tr(ru.participants)}>
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
