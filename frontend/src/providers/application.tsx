import { reaction, runInAction } from "mobx";
import { QueryObserver, useQuery, type QueryClient } from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from "react";
import { store } from "./store";
import { RoomSessionController } from "../application/room/RoomSessionController";
import { RoomPlaybackCoordinator } from "../application/room/RoomPlaybackCoordinator";
import { RoomLibraryCoordinator } from "../application/room/RoomLibraryCoordinator";
import { RoomMembershipCoordinator } from "../application/room/RoomMembershipCoordinator";
import { RoomRuntimeCoordinator } from "../application/room/RoomRuntimeCoordinator";
import type { RoomVoiceCoordinator } from "../application/room/RoomVoiceCoordinator";
import { applyAppFonts } from "../shared/preferences/appFonts";
import type {
  ProcessingJobDto,
} from "../contracts/models";
import { audioClient } from "../services/audioClient";
import { desktopClient } from "../services/desktopClient";
import { pythonClient } from "../services/pythonClient";
import { backendEventsAvailable, refreshOnJobChanges } from "../services/backendEvents";
import { roomClient } from "../services/roomClient";
import { participantId } from "../services/roomMappers";
import { rememberRoomProjectCopy, roomProjectCopy } from "../services/roomProjectCopies";
import { readText, removeKey, storageKey, writeText } from "../shared/storage/localStore";
import { subscribeAppVisibility, appVisibility } from "../app/useAppOnScreen";


const sessionKey = storageKey("roomSession");
const createRoomSession = () => new RoomSessionController(roomClient, audioClient, participantId, {
  load: () => readText(sessionKey),
  save: code => writeText(sessionKey, code),
  clear: () => removeKey(sessionKey),
});
export let roomSession = createRoomSession();
let runtime: RoomRuntimeCoordinator | undefined;
export const getRoomRuntime = (): RoomRuntimeCoordinator => runtime ??= new RoomRuntimeCoordinator(roomSession, {
  room: roomClient, audio: audioClient, python: pythonClient, desktop: desktopClient,
  copies: { get: roomProjectCopy, remember: rememberRoomProjectCopy }, participantId,
});

const emptyJobs: readonly ProcessingJobDto[] = [];
export const useJobs = () => {
  const query = useQuery<readonly ProcessingJobDto[]>({ queryKey: ["jobs"], enabled: false });
  return { jobs: query.data ?? emptyJobs, failed: query.isError };
};

export const subscribeApplication = (client: QueryClient): (() => void) => {
  const activeRuntime = getRoomRuntime();
  let revision = 0;
  const jobs = new QueryObserver(client, {
    queryKey: ["jobs"],
    queryFn: async ({ signal }) => {
      for (;;) {
        const started = revision;
        try {
          const result = await pythonClient.listJobs();
          signal.throwIfAborted();
          if (started === revision) return result;
        } catch (error) {
          signal.throwIfAborted();
          if (started === revision) throw error;
        }
      }
    },
    refetchInterval: backendEventsAvailable() ? 5000 : 1000,
    refetchIntervalInBackground: true,
  });
  const updateJobs = () => runInAction(() => {
    store.application.localProcessing = (jobs.getCurrentResult().data ?? []).some(job =>
      job.type === "SongProcessing" && job.processingBackend === "Local" &&
      ["queued", "processing", "cancelling"].includes(job.state));
  });
  const updateRoom = () => runInAction(() => { store.online.room = roomSession.getRoom(); });
  const updateVisibility = () => runInAction(() => { store.application.onScreen = appVisibility(); });
  const stopJobs = jobs.subscribe(updateJobs);
  updateJobs(); updateRoom(); updateVisibility();
  const stopRoom = roomSession.subscribe(updateRoom);
  const stopVisibility = subscribeAppVisibility(updateVisibility);
  const stopEvents = refreshOnJobChanges(() => {
    revision++;
    void client.invalidateQueries({ queryKey: ["jobs"] }, { cancelRefetch: false });
  }, 250);
  const stopMotion = reaction(() => [store.preferences.reducedMotion,
    store.application.localProcessing, store.application.onScreen] as const,
    ([reduced, processing, visible]) => {
      document.documentElement.dataset.reducedMotion = String(reduced || processing);
      document.documentElement.dataset.adMotion = reduced || processing || !visible ? "off" : "on";
      if (visible && !reduced && !processing) document.dispatchEvent(new Event("visibilitychange"));
    }, { fireImmediately: true });
  const stopFonts = reaction(() => [store.preferences.headingFont, store.preferences.textFont] as const,
    ([heading, text]) => applyAppFonts(heading, text), { fireImmediately: true });
  const stopTheme = reaction(() => store.preferences.theme, theme => {
    document.documentElement.dataset.theme = theme;
    void desktopClient.setAppIcon(theme);
  }, { fireImmediately: true });
  let suspended = false;
  let transition = Promise.resolve();
  const canSuspend = () => store.preferences.releaseAsioInBackground &&
    store.preferences.audio.backend === "ASIO" && store.online.room === null;
  const setSuspended = (next: boolean) => {
    if (suspended === next) return;
    suspended = next;
    transition = transition.then(() => next ? audioClient.suspendSession() : audioClient.resumeSession())
      .catch(() => { suspended = false; });
  };
  const suspend = () => { if (canSuspend() && !store.settingsOpen) setSuspended(true); };
  const resume = () => setSuspended(false);
  const stopAsio = reaction(canSuspend, enabled => { if (!enabled) resume(); }, { fireImmediately: true });
  window.addEventListener("blur", suspend);
  window.addEventListener("focus", resume);
  const stopWindow = desktopClient.onWindowState?.(state => {
    if (state.minimized && canSuspend()) setSuspended(true);
    else if (!state.minimized) resume();
  });
  return () => {
    stopJobs(); jobs.destroy(); stopEvents(); stopRoom(); stopVisibility();
    stopMotion(); stopFonts(); stopTheme(); stopAsio(); stopWindow?.();
    window.removeEventListener("blur", suspend);
    window.removeEventListener("focus", resume);
    activeRuntime.dispose();
    if (runtime === activeRuntime) runtime = undefined;
    roomSession = createRoomSession();
    runInAction(() => { store.online.room = null; store.application.localProcessing = false; });
  };
};

export const useRoomPlayback = (): RoomPlaybackCoordinator | null => {
  const session = roomSession;
  const scope = useSyncExternalStore(session.subscribe, session.getScope, session.getScope);
  return useMemo(() => scope ? new RoomPlaybackCoordinator(scope, roomClient) : null, [scope]);
};

export const useRoomLibraryCommands = (): RoomLibraryCoordinator | null => {
  const session = roomSession;
  const scope = useSyncExternalStore(session.subscribe, session.getScope, session.getScope);
  return useMemo(() => scope ? new RoomLibraryCoordinator(scope, roomClient) : null, [scope]);
};

export const useRoomMembership = (): RoomMembershipCoordinator | null => {
  const session = roomSession;
  const scope = useSyncExternalStore(session.subscribe, session.getScope, session.getScope);
  return useMemo(() => scope
    ? new RoomMembershipCoordinator(scope, roomClient, audioClient, desktopClient) : null, [scope]);
};

export const useRoomVoice = (): RoomVoiceCoordinator | null => {
  const runtime = getRoomRuntime();
  return useSyncExternalStore(runtime.subscribe, runtime.getVoice, runtime.getVoice);
};

