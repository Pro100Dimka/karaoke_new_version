import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useApp } from "../../app/AppContext";
import { useNotify } from "../../app/NotificationsProvider";
import { useServices } from "../../app/ServicesContext";
import chimeUrl from "../../assets/sounds/room-join-leave.mp3";
import { useText } from "../../i18n/useText";
import { audioClient } from "../../services/audioClient";
import { pythonClient } from "../../services/pythonClient";
import { roomClient } from "../../services/roomClient";
import { desktopClient } from "../../services/desktopClient";
import { participantId } from "../../services/roomMappers";
import { toAppError } from "../../shared/errors";
import { routes } from "../../app/routes";
import { applySpeakingLevels, diffParticipants, localReadiness, reconcileRemoteParticipants } from "./roomModel";
import { roomProjectKey, selectedRoomProjectUpload } from "./roomLibrary";
import { downloadAvailableRoomProject } from "./roomProjectDownload";
import { roomKaraokeNavigation } from "./roomNavigation";

const pollMilliseconds = 250;
const levelPollMilliseconds = 80;
const libraryPollMilliseconds = 1000;

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
  const navigate = useNavigate();
  const location = useLocation();
  const pathnameRef = useRef(location.pathname);
  pathnameRef.current = location.pathname;
  const roomRef = useRef(room);
  roomRef.current = room;
  const registeredVoiceRef = useRef(new Set<string>());
  const roomLaunchKeyRef = useRef("");
  const publishedLibraryKeyRef = useRef("");
  const uploadedProjectsRef = useRef(new Set<string>());
  const code = room?.code;

  useEffect(() => {
    if (!code) return;
    let active = true;
    let polling = false;
    registeredVoiceRef.current.clear();
    roomLaunchKeyRef.current = "";
    const showTransferProgress = (progress: number | undefined) => {
      const current = roomRef.current;
      if (!active || !current || current.code !== code) return;
      const updated = { ...current, transferProgress: progress };
      roomRef.current = updated;
      setRoom(updated);
    };
    const enterRoomKaraoke = (
      snapshot: NonNullable<typeof roomRef.current>,
      library: Awaited<ReturnType<typeof pythonClient.listSongs>>
    ) => {
      const decision = roomKaraokeNavigation(snapshot, pathnameRef.current, library);
      if (decision.kind === "stay") {
        if (pathnameRef.current === routes.karaoke(snapshot.songId ?? "")) {
          roomLaunchKeyRef.current = "";
          showTransferProgress(undefined);
        }
        return;
      }
      const key = `${snapshot.code}:${decision.songId}:${decision.revision}`;
      if (roomLaunchKeyRef.current === key) return;
      roomLaunchKeyRef.current = key;
      if (decision.kind === "open") {
        navigate(routes.karaoke(decision.songId), { state: { mode: "RoomPrepared" } });
        return;
      }
      showTransferProgress(10);
      void (async () => {
        try {
          const path = await downloadAvailableRoomProject(
            request => desktopClient.downloadRoomProject(request),
            milliseconds => new Promise(resolve => window.setTimeout(resolve, milliseconds)),
            { roomId: snapshot.code, participantId, songId: decision.songId, revision: decision.revision }
          );
          showTransferProgress(70);
          const imported = await pythonClient.importProject(path, "AcceptOlder");
          showTransferProgress(95);
          if (!active) return;
          navigate(routes.karaoke(imported.id), { state: { mode: "RoomPrepared" } });
        } catch (error) {
          roomLaunchKeyRef.current = "";
          showTransferProgress(undefined);
          console.error("Room project download/import failed", error);
          notify(t("roomNetworkUnavailable"), "error");
        }
      })();
    };
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
          const visibleAfter = roomLaunchKeyRef.current
            ? { ...after, transferProgress: roomRef.current?.transferProgress }
            : after;
          roomRef.current = visibleAfter;
          setRoom(visibleAfter);
          // Each client reports whether it holds the exact project revision the host selected.
          if (python.kind === "ready" && after.songId && after.revision !== undefined) {
            const library = await pythonClient.listSongs();
            enterRoomKaraoke(after, library);
            const self = after.participants.find(person => person.self);
            const wanted = localReadiness(after, library);
            if (self && (wanted === "Ready") !== (self.readiness === "ready")) {
              const readinessRoom = await roomClient.setRoomReadiness(code, wanted);
              const visibleReadiness = roomLaunchKeyRef.current
                ? { ...readinessRoom, transferProgress: roomRef.current?.transferProgress }
                : readinessRoom;
              roomRef.current = visibleReadiness;
              setRoom(visibleReadiness);
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
      registeredVoiceRef.current.clear();
    };
  }, [code, python.kind, setRoom, notify, t, navigate]);

  useEffect(() => {
    if (!code) return;
    let active = true;
    let polling = false;
    const updateLevels = async () => {
      if (polling) return;
      polling = true;
      try {
        const levels = await audioClient.roomLevels();
        const current = roomRef.current;
        if (!active || !current) return;
        const updated = applySpeakingLevels(current, levels);
        roomRef.current = updated;
        setRoom(updated);
      } catch {
        // A transient diagnostics miss must not disconnect an otherwise healthy room.
      } finally {
        polling = false;
      }
    };
    void updateLevels();
    const timer = window.setInterval(() => void updateLevels(), levelPollMilliseconds);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [code, setRoom]);

  useEffect(() => {
    if (!code || python.kind !== "ready") return;
    let active = true;
    let publishing = false;
    publishedLibraryKeyRef.current = "";
    uploadedProjectsRef.current.clear();
    const publishLibrary = async () => {
      if (publishing) return;
      publishing = true;
      try {
        const songs = (await pythonClient.listSongs()).filter(song => song.status === "ready");
        const key = songs.map(song => `${song.id}:${song.activeRevision}`).sort().join("|");
        if (key !== publishedLibraryKeyRef.current) {
          const updated = await roomClient.publishLibrary(code, songs);
          if (!active) return;
          publishedLibraryKeyRef.current = key;
          roomRef.current = updated;
          setRoom(updated);
        }
        const selected = roomRef.current;
        const song = selectedRoomProjectUpload(
          code, songs, uploadedProjectsRef.current, selected?.songId, selected?.revision
        );
        if (song) {
          const uploadKey = roomProjectKey(code, song);
          try {
            const path = await pythonClient.exportProject(song.id, song.activeRevision);
            await desktopClient.uploadRoomProject({
              roomId: code,
              participantId,
              songId: song.id,
              revision: song.activeRevision,
              path
            });
            uploadedProjectsRef.current.add(uploadKey);
          } catch (error) {
            console.error("Room project export/upload failed", error);
            // The next short poll retries the selected archive without blocking library metadata.
          }
        }
      } catch {
        // The next poll retries; local library use must remain available while the room server recovers.
      } finally {
        publishing = false;
      }
    };
    void publishLibrary();
    const timer = window.setInterval(() => void publishLibrary(), libraryPollMilliseconds);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [code, python.kind, setRoom]);

  return null;
};
