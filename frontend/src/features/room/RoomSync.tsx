import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useApp } from "../../app/AppContext";
import { useNotify } from "../../app/NotificationsProvider";
import { useServices } from "../../app/ServicesContext";
import chimeUrlJoin from "../../assets/sounds/room-join.mp3";
import chimeUrlLeave from "../../assets/sounds/room-leave.mp3";
import { useText } from "../../i18n/useText";
import { audioClient } from "../../services/audioClient";
import { pythonClient } from "../../services/pythonClient";
import { roomClient } from "../../services/roomClient";
import { desktopClient } from "../../services/desktopClient";
import { participantId } from "../../services/roomMappers";
import { toAppError } from "../../shared/errors";
import { routes } from "../../app/routes";
import { applySpeakingLevels, diffParticipants, hasCurrentParticipant, localReadiness, reconcileRemoteParticipants, restoreRoomVoiceAfterReconnect } from "./roomModel";
import { roomProjectKey, selectedRoomProjectUpload } from "./roomLibrary";
import { downloadAvailableRoomProject, roomTransferFailure } from "./roomProjectDownload";
import { roomKaraokeNavigation } from "./roomNavigation";
import { calibrationDelayMilliseconds, scheduleCalibrationClicks } from "./roomSyncCheck";
import { roomChimeKinds, type RoomChimeKind } from "./roomChime";
import { createLatestSnapshotQueue } from "./latestSnapshotQueue";

const levelPollMilliseconds = 80;
const libraryPollMilliseconds = 1000;
const curtainMilliseconds = 400;

const chimeUrls = {
  join: chimeUrlJoin,
  leave: chimeUrlLeave,
} satisfies Record<RoomChimeKind, string>;

const playChime = (kind: RoomChimeKind): void => {
  // Short interface sound only; the karaoke audio timeline stays entirely in AudioService.
  void new Audio(chimeUrls[kind]).play().catch(() => undefined);
};

/** Keeps the renderer's room in step with the backend snapshot; renders nothing. */
export const RoomSync = () => {
  const { room, setRoom } = useApp();
  const { python } = useServices();
  const notify = useNotify();
  const t = useText();
  const navigate = useNavigate();
  const location = useLocation();
  const [launching, setLaunching] = useState(false);
  const pathnameRef = useRef(location.pathname);
  pathnameRef.current = location.pathname;
  const roomRef = useRef(room);
  roomRef.current = room;
  const registeredVoiceRef = useRef(new Set<string>());
  const roomLaunchKeyRef = useRef("");
  const completedRoomProjectRef = useRef("");
  const importedRoomProjectsRef = useRef(new Map<string, string>());
  const publishedLibraryKeyRef = useRef("");
  const uploadedProjectsRef = useRef(new Set<string>());
  const syncCheckIdRef = useRef(room?.syncCheckId ?? 0);
  const code = room?.code;

  useEffect(() => desktopClient.onRoomProjectTransferProgress((progress) => {
    const current = roomRef.current;
    if (!current || current.transferId !== progress.transferId) return;
    const ratio = progress.totalBytes > 0
      ? progress.transferredBytes / progress.totalBytes
      : 0;
    if (progress.direction !== "download") return;
    const transferProgress = 10 + Math.round(ratio * 55);
    void roomClient.setRoomReadiness(current.code, "Downloading", transferProgress)
      .then(snapshot => {
        const latest = roomRef.current;
        if (!latest || latest.code !== current.code || latest.transferId !== progress.transferId) return;
        const updated = {
          ...snapshot,
          transferId: progress.transferId,
          transferBytes: progress.transferredBytes,
          transferTotalBytes: progress.totalBytes,
        };
        roomRef.current = updated;
        setRoom(updated);
      })
      .catch(() => undefined);
  }), [setRoom]);

  useEffect(() => {
    if (!code) return;
    let active = true;
    const calibrationCancels = new Set<() => void>();
    syncCheckIdRef.current = roomRef.current?.syncCheckId ?? 0;
    registeredVoiceRef.current.clear();
    roomLaunchKeyRef.current = "";
    importedRoomProjectsRef.current.clear();
    const showTransferProgress = (
      progress: number | undefined,
      transfer?: Pick<NonNullable<typeof roomRef.current>, "transferId" | "transferBytes" | "transferTotalBytes" | "transferError">,
    ) => {
      const current = roomRef.current;
      if (!active || !current || current.code !== code) return;
      const updated = progress === undefined
        ? { ...current, transferProgress: undefined, transferId: undefined,
            transferBytes: undefined, transferTotalBytes: undefined, transferError: undefined }
        : { ...current, transferProgress: progress, ...transfer };
      roomRef.current = updated;
      setRoom(updated);
    };
    const enterRoomKaraoke = (
      snapshot: NonNullable<typeof roomRef.current>,
      library: Awaited<ReturnType<typeof pythonClient.listSongs>>
    ) => {
      const roomProjectId = snapshot.songId && snapshot.revision !== undefined
        ? `${snapshot.songId}:${snapshot.revision}`
        : "";
      const decision = roomKaraokeNavigation(
        snapshot,
        pathnameRef.current,
        library,
        importedRoomProjectsRef.current.get(roomProjectId),
        completedRoomProjectRef.current
      );
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
        setLaunching(true);
        window.setTimeout(() => {
          if (!active) return;
          navigate(routes.karaoke(decision.songId), { state: { mode: "RoomPrepared" } });
          setLaunching(false);
        }, curtainMilliseconds);
        return;
      }
      const transferId = crypto.randomUUID();
      showTransferProgress(10, { transferId, transferBytes: 0, transferTotalBytes: 0, transferError: false });
      void (async () => {
        try {
          const downloading = await roomClient.setRoomReadiness(code, "Downloading", 10);
          roomRef.current = { ...downloading, transferProgress: 10 };
          setRoom(roomRef.current);
          const path = await downloadAvailableRoomProject(
            request => desktopClient.downloadRoomProject(request),
            milliseconds => new Promise(resolve => window.setTimeout(resolve, milliseconds)),
            { roomId: snapshot.code, participantId, songId: decision.songId,
              revision: decision.revision, transferId }
          );
          showTransferProgress(70);
          const importing = await roomClient.setRoomReadiness(code, "Importing", 70);
          roomRef.current = { ...importing, transferProgress: 70 };
          setRoom(roomRef.current);
          const imported = await pythonClient.importProject(path, "AcceptOlder");
          importedRoomProjectsRef.current.set(`${decision.songId}:${decision.revision}`, imported.id);
          showTransferProgress(95);
          const preparing = await roomClient.setRoomReadiness(code, "Preparing", 95);
          roomRef.current = { ...preparing, transferProgress: 95 };
          setRoom(roomRef.current);
          if (!active) return;
          const ready = await roomClient.setRoomReadiness(code, "Ready", 100);
          roomRef.current = ready;
          setRoom(ready);
          roomLaunchKeyRef.current = "";
        } catch (error) {
          const failed = await roomClient.setRoomReadiness(code, "Failed").catch(() => roomRef.current);
          roomLaunchKeyRef.current = "";
          if (failed) {
            const visibleFailure = roomTransferFailure(failed);
            roomRef.current = visibleFailure;
            setRoom(visibleFailure);
          }
          console.error("Room project download/import failed", error);
          notify(t("roomNetworkUnavailable"), "error");
        }
      })();
    };
    const synchronize = async (snapshot: NonNullable<typeof roomRef.current>) => {
      const before = roomRef.current;
      if (!before) return;
      try {
          if (!active) return;
          if (!hasCurrentParticipant(snapshot)) {
            await audioClient.leaveVoiceSession().catch(() => undefined);
            registeredVoiceRef.current.clear();
            roomRef.current = null;
            setRoom(null);
            notify(t("removedFromRoom"), "warning");
            return;
          }
          const after = { ...snapshot, connectionStatus: "connected" as const };
          if (restoreRoomVoiceAfterReconnect(before, after)) {
            await audioClient.joinVoiceSession(code, participantId);
          }
          const syncCheckId = after.syncCheckId ?? 0;
          if (syncCheckId > syncCheckIdRef.current && after.syncCheckStartedAt && after.serverNow) {
            syncCheckIdRef.current = syncCheckId;
            const delay = calibrationDelayMilliseconds(
              after.syncCheckStartedAt,
              after.serverNow,
              0
            );
            const cancel = scheduleCalibrationClicks(delay, () => audioClient.playTestSound());
            calibrationCancels.add(cancel);
          }
          const selectedKey = after.songId && after.revision !== undefined ? `${after.songId}:${after.revision}` : "";
          const wasActive = before.playbackState === "playing" || before.playbackState === "paused";
          if (selectedKey && wasActive && after.playbackState === "stopped") {
            completedRoomProjectRef.current = selectedKey;
          } else if (!selectedKey) {
            completedRoomProjectRef.current = "";
          } else if (completedRoomProjectRef.current === selectedKey
            && after.participants.some(person => person.connected && person.readiness !== "ready")) {
            completedRoomProjectRef.current = "";
          }
          const change = diffParticipants(before, after);
          for (const person of change.joined) if (!person.self) notify(t("participantJoined", { name: person.name }), "info");
          for (const person of change.left) notify(t("participantLeft", { name: person.name }), "info");
          roomChimeKinds({ joined: change.joined.length, left: change.left.length }).forEach(playChime);
          const voiceChange = reconcileRemoteParticipants(registeredVoiceRef.current, after);
          for (const id of voiceChange.add) {
            await audioClient.addRemoteParticipant(id);
            registeredVoiceRef.current.add(id);
          }
          for (const id of voiceChange.remove) {
            await audioClient.removeRemoteParticipant(id).catch(() => undefined);
            registeredVoiceRef.current.delete(id);
          }
          const visibleAfter = after;
          roomRef.current = visibleAfter;
          setRoom(visibleAfter);
          if (python.kind === "ready") {
            if (!after.songId || after.revision === undefined) {
              enterRoomKaraoke(after, []);
            } else {
              // Each client reports whether it holds the exact project revision the host selected.
              const library = await pythonClient.listSongs();
              enterRoomKaraoke(after, library);
              const self = after.participants.find(person => person.self);
              const mappedLocalSongId = importedRoomProjectsRef.current.get(`${after.songId}:${after.revision}`);
              const wanted = localReadiness(after, library, mappedLocalSongId);
              if (self && (wanted === "Ready") !== (self.readiness === "ready")) {
                const readinessRoom = await roomClient.setRoomReadiness(code, wanted);
                const visibleReadiness = readinessRoom;
                roomRef.current = visibleReadiness;
                setRoom(visibleReadiness);
              }
            }
          }
      } catch (error) {
          if (toAppError(error).code === "RoomNotFound") {
            await audioClient.leaveVoiceSession().catch(() => undefined);
            roomRef.current = null;
            setRoom(null);
            notify(t("roomClosed"), "warning");
          } else {
            const current = roomRef.current;
            if (active && current && current.connectionStatus !== "reconnecting") {
              const reconnecting = { ...current, connectionStatus: "reconnecting" as const };
              roomRef.current = reconnecting;
              setRoom(reconnecting);
            }
          }
      }
    };
    const snapshots = createLatestSnapshotQueue(synchronize);
    const unsubscribe = roomClient.watchRoom(
      code,
      snapshot => void snapshots.push(snapshot),
      error => {
        if (toAppError(error).code === "RoomNotFound") {
          void audioClient.leaveVoiceSession().catch(() => undefined);
          roomRef.current = null;
          setRoom(null);
          notify(t("roomClosed"), "warning");
          return;
        }
        const current = roomRef.current;
        if (active && current && current.connectionStatus !== "reconnecting") {
          const reconnecting = { ...current, connectionStatus: "reconnecting" as const };
          roomRef.current = reconnecting;
          setRoom(reconnecting);
        }
      },
    );
    return () => {
      active = false;
      unsubscribe();
      calibrationCancels.forEach(cancel => cancel());
      calibrationCancels.clear();
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
          const transferId = crypto.randomUUID();
          try {
            const path = await pythonClient.exportProject(song.id, song.activeRevision);
            await desktopClient.uploadRoomProject({
              roomId: code,
              participantId,
              songId: song.id,
              revision: song.activeRevision,
              path,
              transferId,
            });
            uploadedProjectsRef.current.add(uploadKey);
          } catch (error) {
            console.error("Room project export/upload failed", error);
            const failed = roomRef.current;
            if (failed?.transferId === transferId) {
              const visibleFailure = { ...failed, transferError: true };
              roomRef.current = visibleFailure;
              setRoom(visibleFailure);
            }
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

  return launching ? <div className="roomSceneCurtain" aria-hidden /> : null;
};
