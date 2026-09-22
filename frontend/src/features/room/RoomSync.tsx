import { useEffect, useRef } from "react";
import { useApp } from "../../app/AppContext";
import { useNotify } from "../../app/NotificationsProvider";
import { useServices } from "../../app/ServicesContext";
import chimeUrl from "../../assets/sounds/room-join-leave.mp3";
import { useText } from "../../i18n/useText";
import { audioClient } from "../../services/audioClient";
import { pythonClient } from "../../services/pythonClient";
import { roomClient } from "../../services/roomClient";
import { toAppError } from "../../shared/errors";
import { diffParticipants, localReadiness, playbackPlan, reconcileRemoteParticipants } from "./roomModel";

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
  const registeredVoiceRef = useRef(new Set<string>());
  const playbackKeyRef = useRef("");
  const playbackTimerRef = useRef<number | undefined>(undefined);
  const code = room?.code;

  useEffect(() => {
    if (!code) return;
    let active = true;
    let polling = false;
    registeredVoiceRef.current.clear();
    playbackKeyRef.current = "";
    const synchronize = async () => {
      if (polling) return;
      const before = roomRef.current;
      if (!before) return;
      polling = true;
      try {
          const after = await roomClient.getRoom(code);
          if (!active) return;
          const change = diffParticipants(before, after);
          for (const person of change.joined) if (!person.self) notify(t("participantJoined", { name: person.name }), "info");
          for (const person of change.left) notify(t("participantLeft", { name: person.name }), "info");
          if (change.joined.length + change.left.length > 0) playChime();
          const voiceChange = reconcileRemoteParticipants(registeredVoiceRef.current, after);
          for (const id of voiceChange.add) {
            await audioClient.addRemoteParticipant(id);
            registeredVoiceRef.current.add(id);
          }
          for (const id of voiceChange.remove) {
            await audioClient.removeRemoteParticipant(id).catch(() => undefined);
            registeredVoiceRef.current.delete(id);
          }
          setRoom(after);
          const playbackKey = [after.songId, after.revision, after.playbackState, after.playbackStartedAt, after.playbackPositionSeconds].join("|");
          if (after.songId && playbackKey !== playbackKeyRef.current && python.kind === "ready") {
            if (playbackTimerRef.current !== undefined) window.clearTimeout(playbackTimerRef.current);
            const plan = playbackPlan(after);
            if (plan.kind === "stop") {
              await audioClient.stop().catch(() => undefined);
            } else {
              const preparationStarted = performance.now();
              const song = await pythonClient.getSong(after.songId);
              await audioClient.prepareSong(song);
              if (plan.kind === "schedule") {
                const remaining = Math.max(0, plan.delayMilliseconds - (performance.now() - preparationStarted));
                playbackTimerRef.current = window.setTimeout(
                  () => void audioClient.play().catch(() => { playbackKeyRef.current = ""; }),
                  remaining
                );
              } else if (plan.kind === "play") {
                if (plan.positionSeconds > 0) await audioClient.seek(plan.positionSeconds);
                await audioClient.play();
              } else {
                await audioClient.seek(plan.positionSeconds);
                await audioClient.pause();
              }
            }
            playbackKeyRef.current = playbackKey;
          }
          // Each client reports whether it holds the exact project revision the host selected.
          if (python.kind === "ready" && after.songId && after.revision !== undefined) {
            const library = await pythonClient.listSongs();
            const self = after.participants.find(person => person.self);
            const wanted = localReadiness(after, library);
            if (self && (wanted === "Ready") !== (self.readiness === "ready")) {
              setRoom(await roomClient.setRoomReadiness(code, wanted));
            }
          }
      } catch (error) {
          if (toAppError(error).code === "RoomNotFound") {
            setRoom(null);
            notify(t("roomClosed"), "warning");
          }
      } finally {
        polling = false;
      }
    };
    void synchronize();
    const timer = window.setInterval(() => void synchronize(), pollMilliseconds);
    return () => {
      active = false;
      window.clearInterval(timer);
      if (playbackTimerRef.current !== undefined) window.clearTimeout(playbackTimerRef.current);
      registeredVoiceRef.current.clear();
    };
  }, [code, python.kind, setRoom, notify, t]);

  return null;
};
