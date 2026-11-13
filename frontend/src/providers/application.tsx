import { setDecorationLevel } from '@neo-ui-kit/react';
import {
  QueryObserver,
  useQuery,
  type QueryClient,
} from '@tanstack/react-query';
import { reaction, runInAction } from 'mobx';
import { useMemo, useSyncExternalStore } from 'react';
import { appVisibility, subscribeAppVisibility } from '../app/useAppOnScreen';
import { RoomLibraryCoordinator } from '../application/room/RoomLibraryCoordinator';
import { RoomMembershipCoordinator } from '../application/room/RoomMembershipCoordinator';
import { RoomPlaybackCoordinator } from '../application/room/RoomPlaybackCoordinator';
import { RoomRuntimeCoordinator } from '../application/room/RoomRuntimeCoordinator';
import { RoomSessionController } from '../application/room/RoomSessionController';
import type { RoomVoiceCoordinator } from '../application/room/RoomVoiceCoordinator';
import type { ProcessingJobDto } from '../contracts/models';
import { audioClient } from '../services/audioClient';
import {
  backendPollInterval,
  onJobChange,
  onModelsChange,
  refreshOnJobChanges,
} from '../services/backendEvents';
import { desktopClient } from '../services/desktopClient';
import { pythonClient } from '../services/pythonClient';
import { roomClient } from '../services/roomClient';
import { participantId } from '../services/roomMappers';
import {
  rememberRoomProjectCopy,
  roomProjectCopy,
} from '../services/roomProjectCopies';
import {
  clearOperationFailure,
  reportOperationFailure,
} from '../shared/errors';
import { applyAppFonts } from '../shared/preferences/appFonts';
import {
  readText,
  removeKey,
  storageKey,
  writeText,
} from '../shared/storage/localStore';
import { store } from './store';

const sessionKey = storageKey('roomSession');
const createRoomSession = () =>
  new RoomSessionController(roomClient, audioClient, participantId, {
    load: () => readText(sessionKey),
    save: (code) => writeText(sessionKey, code),
    clear: () => removeKey(sessionKey),
  });
export let roomSession = createRoomSession();
let runtime: RoomRuntimeCoordinator | undefined;
export const getRoomRuntime = (): RoomRuntimeCoordinator =>
  (runtime ??= new RoomRuntimeCoordinator(roomSession, {
    room: roomClient,
    audio: audioClient,
    python: pythonClient,
    desktop: desktopClient,
    copies: { get: roomProjectCopy, remember: rememberRoomProjectCopy },
    participantId,
  }));

const emptyJobs: readonly ProcessingJobDto[] = [];
export const useJobs = () => {
  const query = useQuery<readonly ProcessingJobDto[]>({
    queryKey: ['jobs'],
    enabled: false,
  });
  return { jobs: query.data ?? emptyJobs, failed: query.isError };
};

export const subscribeApplication = (client: QueryClient): (() => void) => {
  const activeRuntime = getRoomRuntime();
  let revision = 0;
  const jobs = new QueryObserver(client, {
    queryKey: ['jobs'],
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
    refetchInterval: backendPollInterval(1000),
    refetchIntervalInBackground: true,
  });
  const updateJobs = () =>
    runInAction(() => {
      store.application.localProcessing = (
        jobs.getCurrentResult().data ?? []
      ).some(
        (job) =>
          job.type === 'SongProcessing' &&
          job.processingBackend === 'Local' &&
          ['queued', 'processing', 'cancelling'].includes(job.state),
      );
    });
  const updateRoom = () =>
    runInAction(() => {
      store.online.room = roomSession.getRoom();
    });
  const updateVisibility = () =>
    runInAction(() => {
      store.application.onScreen = appVisibility();
    });
  const stopJobs = jobs.subscribe(updateJobs);
  updateJobs();
  updateRoom();
  updateVisibility();
  const stopRoom = roomSession.subscribe(updateRoom);
  const stopVisibility = subscribeAppVisibility(updateVisibility);
  const stopEvents = refreshOnJobChanges(() => {
    revision++;
    void client.invalidateQueries(
      { queryKey: ['jobs'] },
      { cancelRefetch: false },
    );
  }, 250);
  const stopJobQueries = onJobChange((_jobId, job) => {
    const queryKey =
      typeof job?.type === 'string' && typeof job.entityId === 'string'
        ? ['job', job.type, job.entityId]
        : ['job'];
    void client.invalidateQueries({ queryKey });
  });
  const stopModels = onModelsChange(() => {
    for (const queryKey of [['models'], ['model-free-space']])
      void client.invalidateQueries({ queryKey });
  });
  const systemMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const applyMotion = () => {
    const { localProcessing, onScreen } = store.application;
    const reduced = systemMotion.matches || localProcessing;
    setDecorationLevel(store.preferences.reducedMotion ? 'light' : 'full');
    document.documentElement.dataset.reducedMotion = String(reduced);
    document.documentElement.dataset.adMotion =
      reduced || !onScreen ? 'off' : 'on';
    document.dispatchEvent(new Event('visibilitychange'));
  };
  const stopMotion = reaction(
    () =>
      [
        store.preferences.reducedMotion,
        store.application.localProcessing,
        store.application.onScreen,
      ] as const,
    applyMotion,
    { fireImmediately: true },
  );
  systemMotion.addEventListener('change', applyMotion);
  const stopFonts = reaction(
    () => [store.preferences.headingFont, store.preferences.textFont] as const,
    ([heading, text]) => applyAppFonts(heading, text),
    { fireImmediately: true },
  );
  const stopTheme = reaction(
    () => store.preferences.theme,
    (theme) => {
      document.documentElement.dataset.theme = theme;
      void desktopClient.setAppIcon(theme);
    },
    { fireImmediately: true },
  );
  return () => {
    stopJobs();
    jobs.destroy();
    stopEvents();
    stopJobQueries();
    stopModels();
    stopRoom();
    stopVisibility();
    stopMotion();
    systemMotion.removeEventListener('change', applyMotion);
    stopFonts();
    stopTheme();
    activeRuntime.dispose();
    if (runtime === activeRuntime) runtime = undefined;
    roomSession = createRoomSession();
    runInAction(() => {
      store.online.room = null;
      store.application.localProcessing = false;
    });
  };
};

export const useRoomPlayback = (): RoomPlaybackCoordinator | null => {
  const session = roomSession;
  const scope = useSyncExternalStore(
    session.subscribe,
    session.getScope,
    session.getScope,
  );
  return useMemo(
    () => (scope ? new RoomPlaybackCoordinator(scope, roomClient) : null),
    [scope],
  );
};

export const useRoomLibraryCommands = (): RoomLibraryCoordinator | null => {
  const session = roomSession;
  const scope = useSyncExternalStore(
    session.subscribe,
    session.getScope,
    session.getScope,
  );
  return useMemo(
    () => (scope ? new RoomLibraryCoordinator(scope, roomClient) : null),
    [scope],
  );
};

export const useRoomMembership = (): RoomMembershipCoordinator | null => {
  const session = roomSession;
  const scope = useSyncExternalStore(
    session.subscribe,
    session.getScope,
    session.getScope,
  );
  return useMemo(
    () =>
      scope
        ? new RoomMembershipCoordinator(
            scope,
            roomClient,
            audioClient,
            desktopClient,
          )
        : null,
    [scope],
  );
};

export const useRoomVoice = (): RoomVoiceCoordinator | null => {
  const runtime = getRoomRuntime();
  return useSyncExternalStore(
    runtime.subscribe,
    runtime.getVoice,
    runtime.getVoice,
  );
};

export const subscribeAudioFocus = (settingsOpen: () => boolean) => {
  let suspended = false;
  let transition = Promise.resolve();
  const canSuspend = () =>
    store.preferences.releaseAsioInBackground &&
    store.preferences.audio.backend === 'ASIO' &&
    store.online.room === null;
  const setSuspended = (next: boolean) => {
    if (suspended === next) return;
    suspended = next;
    transition = transition
      .then(() =>
        next ? audioClient.suspendSession() : audioClient.resumeSession(),
      )
      .then(() => clearOperationFailure('errors.audioFocus'))
      .catch((error: unknown) => {
        suspended = false;
        reportOperationFailure('errors.audioFocus', error);
      });
  };
  const suspend = () => {
    if (canSuspend() && !settingsOpen()) setSuspended(true);
  };
  const resume = () => setSuspended(false);
  const stopAsio = reaction(
    canSuspend,
    (enabled) => {
      if (!enabled) resume();
    },
    { fireImmediately: true },
  );
  window.addEventListener('blur', suspend);
  window.addEventListener('focus', resume);
  const stopWindow = desktopClient.onWindowState?.((state) => {
    if (state.minimized && canSuspend()) setSuspended(true);
    else if (!state.minimized) resume();
  });
  return () => {
    stopAsio();
    stopWindow?.();
    window.removeEventListener('blur', suspend);
    window.removeEventListener('focus', resume);
  };
};
