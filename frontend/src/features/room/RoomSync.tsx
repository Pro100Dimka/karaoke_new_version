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
import { diffParticipants, hasCurrentParticipant, localReadiness, reconcileRemoteParticipants, restoreRoomVoiceAfterReconnect } from "./roomModel";
import { roomProjectKey, selectedRoomProjectUpload } from "./roomLibrary";
import {
  downloadAvailableRoomProject,
  isProjectConflict,
  preserveLocalRoomTransfer,
  roomImportDecision,
  roomTransferFailure,
} from "./roomProjectDownload";
import { roomKaraokeNavigation } from "./roomNavigation";
import { calibrationDelayMilliseconds, scheduleCalibrationClicks } from "./roomSyncCheck";
import { roomChimeKinds, type RoomChimeKind } from "./roomChime";
import { createLatestSnapshotQueue } from "./latestSnapshotQueue";
import { useRoomDiagnosticsUpload } from "./useRoomDiagnosticsUpload";
import { useRoomVoicePolls } from "./useRoomVoicePolls";
import { rememberRoomProjectCopy, roomProjectCopy } from "./roomProjectCopies";

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
  // The transfer that last failed: it waits for the singer's retry instead of starting again.
  const failedLaunchKeyRef = useRef("");
  const completedRoomProjectRef = useRef("");
  const publishedLibraryKeyRef = useRef("");
  const uploadedProjectsRef = useRef(new Set<string>());
  const syncCheckIdRef = useRef(room?.syncCheckId ?? 0);
  const code = room?.code;
  useRoomDiagnosticsUpload(code);

  useEffect(() => {
    let active = true;
    type Progress = Parameters<Parameters<typeof desktopClient.onRoomProjectTransferProgress>[0]>[0];
    // The room hears whole percents: a readiness post per received chunk was ten requests a second.
    let postedProgress = "";
    const queue = createLatestSnapshotQueue<Progress>(async progress => {
      const current = roomRef.current;
      if (!active || !current || current.transferId !== progress.transferId
        || progress.direction !== "download" || (current.transferProgress ?? 0) >= 70) return;
      const ratio = progress.totalBytes > 0 ? Math.min(1, progress.transferredBytes / progress.totalBytes) : 0;
      const transferProgress = 10 + Math.round(ratio * 55);
      const posted = `${progress.transferId}:${transferProgress}`;
      if (posted === postedProgress) return;
      postedProgress = posted;
      try {
        const snapshot = await roomClient.setRoomReadiness(current.code, "Downloading", transferProgress);
        const latest = roomRef.current;
        if (!active || !latest || latest.code !== current.code || latest.transferId !== progress.transferId
          || (latest.transferProgress ?? 0) >= 70) return;
        const updated = {
          ...snapshot,
          transferProgress,
          transferId: progress.transferId,
          transferBytes: progress.transferredBytes,
          transferTotalBytes: progress.totalBytes,
        };
        roomRef.current = updated;
        setRoom(updated);
      } catch { /* The next progress sample retries while the transfer continues. */ }
    });
    const unsubscribe = desktopClient.onRoomProjectTransferProgress(progress => { void queue.push(progress); });
    return () => { active = false; unsubscribe(); };
  }, [setRoom]);

  useEffect(() => {
    if (!code) return;
    let active = true;
    let launchGeneration = 0;
    let cancelLaunch: (() => void) | undefined;
    const selectionKey = (snapshot: NonNullable<typeof roomRef.current>) => `${snapshot.songId ?? ""}:${snapshot.revision ?? ""}`;
    let selectedProject = roomRef.current ? selectionKey(roomRef.current) : "";
    const calibrationCancels = new Set<() => void>();
    syncCheckIdRef.current = roomRef.current?.syncCheckId ?? 0;
    registeredVoiceRef.current.clear();
    roomLaunchKeyRef.current = "";
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
      if (!active || roomRef.current?.code !== code || selectionKey(snapshot) !== selectedProject) return;
      const decision = roomKaraokeNavigation(
        snapshot,
        pathnameRef.current,
        library,
        roomProjectCopy(snapshot.songId, snapshot.revision),
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
      const selfReadiness = snapshot.participants.find(person => person.self)?.readiness;
      if (failedLaunchKeyRef.current === key && selfReadiness === "failed") return;
      failedLaunchKeyRef.current = "";
      cancelLaunch?.();
      const generation = ++launchGeneration;
      const isCurrent = () => active && generation === launchGeneration && roomRef.current?.code === code;
      roomLaunchKeyRef.current = key;
      if (decision.kind === "open") {
        setLaunching(true);
        const timer = window.setTimeout(() => {
          if (!isCurrent()) return;
          navigate(routes.karaoke(decision.songId), { state: { mode: "RoomPrepared" } });
          setLaunching(false);
        }, curtainMilliseconds);
        cancelLaunch = () => { window.clearTimeout(timer); setLaunching(false); };
        return;
      }
      const transferId = crypto.randomUUID();
      const controller = new AbortController();
      let cancelled = false;
      const cancelTransfer = () => {
        if (cancelled) return;
        cancelled = true;
        void desktopClient.cancelRoomProjectTransfer(transferId).catch(() => undefined);
      };
      cancelLaunch = () => { controller.abort(); cancelTransfer(); };
      showTransferProgress(10, { transferId, transferBytes: 0, transferTotalBytes: 0, transferError: false });
      void (async () => {
        let archive: string | undefined;
        try {
          const downloading = await roomClient.setRoomReadiness(code, "Downloading", 10);
          if (!isCurrent()) return;
          roomRef.current = {
            ...downloading,
            transferProgress: 10,
            transferId,
            transferBytes: 0,
            transferTotalBytes: 0,
            transferError: false,
          };
          setRoom(roomRef.current);
          archive = await downloadAvailableRoomProject(
            async request => {
              const file = await desktopClient.downloadRoomProject(request);
              if (!isCurrent() || cancelled) {
                await desktopClient.releaseRoomProjectDownload(file);
                throw new DOMException("Room transfer cancelled", "AbortError");
              }
              return file;
            },
            milliseconds => new Promise(resolve => window.setTimeout(resolve, milliseconds)),
            { roomId: snapshot.code, participantId, songId: decision.songId,
              revision: decision.revision, transferId },
            { signal: controller.signal, cancel: cancelTransfer },
          );
          if (!isCurrent()) return;
          showTransferProgress(70);
          const importing = await roomClient.setRoomReadiness(code, "Importing", 70);
          if (!isCurrent()) return;
          roomRef.current = preserveLocalRoomTransfer(roomRef.current ?? importing, { ...importing, transferProgress: 70 });
          setRoom(roomRef.current);
          const imported = await pythonClient.importProject(
            archive, roomImportDecision(decision.songId, decision.revision));
          if (!isCurrent()) return;
          rememberRoomProjectCopy(decision.songId, decision.revision, imported.id);
          showTransferProgress(95);
          const preparing = await roomClient.setRoomReadiness(code, "Preparing", 95);
          if (!isCurrent()) return;
          roomRef.current = preserveLocalRoomTransfer(roomRef.current ?? preparing, { ...preparing, transferProgress: 95 });
          setRoom(roomRef.current);
          roomLaunchKeyRef.current = "";
          const library = await pythonClient.listSongs();
          if (!isCurrent()) return;
          enterRoomKaraoke(preparing, library);
        } catch (error) {
          if (!isCurrent()) return;
          const failed = await roomClient.setRoomReadiness(code, "Failed").catch(() => roomRef.current);
          if (!isCurrent()) return;
          roomLaunchKeyRef.current = "";
          failedLaunchKeyRef.current = key;
          const conflict = isProjectConflict(error);
          if (failed) {
            const visibleFailure = roomTransferFailure(failed, conflict);
            roomRef.current = visibleFailure;
            setRoom(visibleFailure);
          }
          console.error("Room project download/import failed", error);
          notify(t(conflict ? "roomProjectConflict" : "roomNetworkUnavailable"), conflict ? "warning" : "error");
        } finally {
          if (archive) await desktopClient.releaseRoomProjectDownload(archive)
            .catch(error => console.error("Room archive cleanup failed", error));
        }
      })();
    };
    const markReconnecting = () => {
      const current = roomRef.current;
      if (active && current && current.connectionStatus !== "reconnecting") {
        const reconnecting = { ...current, connectionStatus: "reconnecting" as const };
        roomRef.current = reconnecting;
        setRoom(reconnecting);
      }
    };
    const synchronize = async (snapshot: NonNullable<typeof roomRef.current>) => {
      const before = roomRef.current;
      const isCurrent = () => active && roomRef.current?.code === code && selectionKey(snapshot) === selectedProject;
      if (!before || !isCurrent()) return;
      try {
          if (!hasCurrentParticipant(snapshot)) {
            await audioClient.leaveVoiceSession().catch(() => undefined);
            if (!isCurrent()) return;
            registeredVoiceRef.current.clear();
            roomRef.current = null;
            setRoom(null);
            notify(t("removedFromRoom"), "warning");
            return;
          }
          const after = { ...snapshot, connectionStatus: "connected" as const };
          if (restoreRoomVoiceAfterReconnect(before, after)) {
            await audioClient.joinVoiceSession(code, participantId, after.serverClockOffsetMilliseconds);
            if (!isCurrent()) return;
          }
          await audioClient.synchronizeRoomClock(after.serverClockOffsetMilliseconds);
          if (!isCurrent()) return;
          // The server is the conductor: owner and participants use the identical fixed deadline.
          await audioClient.setRoomPlayoutDelay(after.roomPlayoutDelayMs ?? 10);
          if (!isCurrent()) return;
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
            if (!isCurrent()) return;
            registeredVoiceRef.current.add(id);
          }
          for (const id of voiceChange.remove) {
            await audioClient.removeRemoteParticipant(id).catch(() => undefined);
            if (!isCurrent()) return;
            registeredVoiceRef.current.delete(id);
          }
          const visibleAfter = preserveLocalRoomTransfer(before, after);
          roomRef.current = visibleAfter;
          setRoom(visibleAfter);
          if (python.kind === "ready") {
            if (!after.songId || after.revision === undefined) {
              enterRoomKaraoke(after, []);
            } else {
              // Each client reports whether it holds the exact project revision the host selected.
              const library = await pythonClient.listSongs();
              if (!isCurrent()) return;
              enterRoomKaraoke(after, library);
              const self = after.participants.find(person => person.self);
              const wanted = localReadiness(after, library, roomProjectCopy(after.songId, after.revision));
              const readiness = self ? {
                Ready: ["missing", "failed", "disconnected"].includes(self.readiness) ? "Preparing" : undefined,
                // A failed transfer waits for the singer's retry (or choice, on a conflict); starting it
                // again by itself downloaded the whole project over and over for a deterministic error.
                MissingSong: !["missing", "downloading", "verifying", "failed"].includes(self.readiness) ? "MissingSong" : undefined,
              } as const : undefined;
              const nextReadiness = readiness?.[wanted];
              if (nextReadiness) {
                const readinessRoom = await roomClient.setRoomReadiness(code, nextReadiness);
                if (!isCurrent()) return;
                const visibleReadiness = readinessRoom;
                roomRef.current = visibleReadiness;
                setRoom(visibleReadiness);
              }
            }
          }
      } catch (error) {
          if (!isCurrent()) return;
          if (toAppError(error).code === "RoomNotFound") {
            await audioClient.leaveVoiceSession().catch(() => undefined);
            if (!isCurrent()) return;
            roomRef.current = null;
            setRoom(null);
            notify(t("roomClosed"), "warning");
          } else {
            markReconnecting();
          }
      }
    };
    const snapshots = createLatestSnapshotQueue(synchronize);
    const unsubscribe = roomClient.watchRoom(
      code,
      snapshot => {
        if (!active) return;
        const selected = selectionKey(snapshot);
        if (selected !== selectedProject) {
          selectedProject = selected;
          ++launchGeneration;
          cancelLaunch?.();
          cancelLaunch = undefined;
          roomLaunchKeyRef.current = "";
        }
        void snapshots.push(snapshot);
      },
      error => {
        if (!active || roomRef.current?.code !== code) return;
        if (toAppError(error).code === "RoomNotFound") {
          void audioClient.leaveVoiceSession().catch(() => undefined);
          roomRef.current = null;
          setRoom(null);
          notify(t("roomClosed"), "warning");
          return;
        }
        markReconnecting();
      },
    );
    return () => {
      active = false;
      ++launchGeneration;
      cancelLaunch?.();
      unsubscribe();
      calibrationCancels.forEach(cancel => cancel());
      calibrationCancels.clear();
      registeredVoiceRef.current.clear();
    };
  }, [code, python.kind, setRoom, notify, t, navigate]);

  useRoomVoicePolls(code, roomRef, setRoom);

  useEffect(() => {
    if (!code || python.kind !== "ready") return;
    let active = true;
    let publishing = false;
    publishedLibraryKeyRef.current = "";
    uploadedProjectsRef.current.clear();
    let activeUpload: string | undefined;
    const publishLibrary = async () => {
      if (publishing) return;
      publishing = true;
      try {
        const songs = (await pythonClient.listSongs()).filter(song => song.status === "ready");
        if (!active || roomRef.current?.code !== code) return;
        const key = songs.map(song => `${song.id}:${song.activeRevision}`).sort().join("|");
        if (key !== publishedLibraryKeyRef.current) {
          const updated = await roomClient.publishLibrary(code, songs);
          if (!active) return;
          publishedLibraryKeyRef.current = key;
          roomRef.current = updated;
          setRoom(updated);
        }
        const selected = roomRef.current;
        const selectedOwner = selected?.sharedSongs?.find(song =>
          song.songId === selected.songId && song.revision === selected.revision
        )?.ownerParticipantId;
        const song = selectedRoomProjectUpload(
          code, songs, uploadedProjectsRef.current, selected?.songId, selected?.revision,
          selectedOwner, participantId
        );
        if (song) {
          const uploadKey = roomProjectKey(code, song);
          const transferId = crypto.randomUUID();
          try {
            const path = await pythonClient.exportProject(song.id, song.activeRevision);
            if (!active || roomRef.current?.code !== code) return;
            activeUpload = transferId;
            await desktopClient.uploadRoomProject({
              roomId: code,
              participantId,
              songId: song.id,
              revision: song.activeRevision,
              path,
              transferId,
            });
            if (!active || roomRef.current?.code !== code) return;
            uploadedProjectsRef.current.add(uploadKey);
          } catch (error) {
            if (!active) return;
            console.error("Room project export/upload failed", error);
            const failed = roomRef.current;
            if (failed?.transferId === transferId) {
              const visibleFailure = { ...failed, transferError: true };
              roomRef.current = visibleFailure;
              setRoom(visibleFailure);
            }
            // The next short poll retries the selected archive without blocking library metadata.
          } finally {
            activeUpload = undefined;
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
      if (activeUpload) void desktopClient.cancelRoomProjectTransfer(activeUpload).catch(() => undefined);
    };
  }, [code, python.kind, setRoom]);

  return launching ? <div className="roomSceneCurtain" aria-hidden /> : null;
};
