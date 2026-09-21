import { useEffect, useRef } from "react";
import { useApp } from "../../app/AppContext";
import { useNotify } from "../../app/NotificationsProvider";
import { useServices } from "../../app/ServicesContext";
import chimeUrl from "../../assets/sounds/room-join-leave.mp3";
import { useText } from "../../i18n/useText";
import { pythonClient } from "../../services/pythonClient";
import { toAppError } from "../../shared/errors";
import { diffParticipants, localReadiness } from "./roomModel";

const pollMilliseconds = 1500;

const playChime = (): void => {
  // Short interface sound only; the karaoke audio timeline stays entirely in AudioService.
  void new Audio(chimeUrl).play().catch(() => undefined);
};

/** Keeps the renderer's room in step with the backend snapshot; renders nothing. */
export const RoomSync = () => {
  const { room, setRoom } = useApp();
  const { python } = useServices();
  const notify = useNotify();
  const t = useText();
  const roomRef = useRef(room);
  roomRef.current = room;
  const code = room?.code;

  useEffect(() => {
    if (!code) return;
    const timer = window.setInterval(() => {
      const before = roomRef.current;
      if (!before || python.kind !== "ready") return;
      void pythonClient
        .getRoom(code)
        .then(async after => {
          const change = diffParticipants(before, after);
          for (const person of change.joined) if (!person.self) notify(t("participantJoined", { name: person.name }), "info");
          for (const person of change.left) notify(t("participantLeft", { name: person.name }), "info");
          if (change.joined.length + change.left.length > 0) playChime();
          setRoom(after);
          // Each client reports whether it holds the exact project revision the host selected.
          if (after.songId && after.revision !== undefined) {
            const library = await pythonClient.listSongs();
            const self = after.participants.find(person => person.self);
            const wanted = localReadiness(after, library);
            if (self && (wanted === "Ready") !== (self.readiness === "ready")) {
              setRoom(await pythonClient.setRoomReadiness(code, wanted));
            }
          }
        })
        .catch(error => {
          if (toAppError(error).code === "RoomNotFound") {
            setRoom(null);
            notify(t("roomClosed"), "warning");
          }
        });
    }, pollMilliseconds);
    return () => window.clearInterval(timer);
  }, [code, python.kind, setRoom, notify, t]);

  return null;
};
