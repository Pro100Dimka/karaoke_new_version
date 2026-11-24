import { setDecorationLevel } from '@neo-ui-kit/react';
import {
  QueryObserver,
  useQuery,
  type QueryClient,
  type Query,
  type QueryKey,
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
import { RoomVoiceSettingsCoordinator } from '../application/room/RoomVoiceSettingsCoordinator';
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
import { createJobSnapshotReader } from '../services/jobSnapshot';
import { recordingCoordinator } from '../services/recordingCoordinator';
import { roomClient } from '../services/roomClient';
import { participantId } from '../services/roomMappers';
import {
  rememberRoomProjectCopy,
  roomProjectCopy,
} from '../services/roomProjectCopies';
import {
  clearOperationFailure,
  observeOperation,
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
export const roomVoiceSettings = new RoomVoiceSettingsCoordinator(
  { getScope: () => roomSession.getScope() },
  roomClient,
  {
    read: () => ({
      ...store.preferences.karaokeEffects,
      noiseSuppression: store.preferences.noiseSuppression,
      voiceGain: store.preferences.voiceGain,
    }),
    write: ({ voiceGain, noiseSuppression, ...karaokeEffects }) =>
      store.updatePreferences({ voiceGain, noiseSuppression, karaokeEffects }),
  },
  participantId,
);
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
  const cache = client.getQueryCache();
  const pendingRefreshes = new Set<Query>();
  const refreshTimers = new Map<Query, number>();
  const jobSnapshots = createJobSnapshotReader(
    (ids, signal) => {
      const query = cache.find({ queryKey: ['jobs'], exact: true });
      if (query) pendingRefreshes.delete(query);
      return pythonClient.listJobs(ids, signal);
    },
    () => client.getQueryData<readonly ProcessingJobDto[]>(['jobs']),
  );
  let eventRefresh = false;
  let active = true;
  const invalidateFromEvent = (queryKey: QueryKey, exact = false) => {
    // Capture this when the query starts. Manual, resumed and periodic reads
    // retain their full-snapshot semantics.
    eventRefresh = true;
    try {
      void client.invalidateQueries(
        { queryKey, exact },
        { cancelRefetch: false },
      );
    } finally {
      eventRefresh = false;
    }
  };
  const clearRefresh = (query: Query) => {
    window.clearTimeout(refreshTimers.get(query));
    refreshTimers.delete(query);
  };
  const refreshJobs = (queryKey: QueryKey) => {
    for (const query of cache.findAll({ queryKey, type: 'active' })) {
      clearRefresh(query);
      if (query.state.fetchStatus === 'fetching') pendingRefreshes.add(query);
    }
    invalidateFromEvent(queryKey);
  };
  // Events during a read need one trailing refresh. Cancelling every read can
  // starve publication and leaves the uncancellable desktop HTTP work running.
  const stopRefreshes = cache.subscribe((event) => {
    const query = event.query;
    if (event.type === 'removed') {
      pendingRefreshes.delete(query);
      clearRefresh(query);
    }
    if (
      event.type !== 'updated' ||
      query.state.fetchStatus !== 'idle' ||
      !pendingRefreshes.delete(query) ||
      event.action.type !== 'success'
    )
      return;
    refreshTimers.set(
      query,
      window.setTimeout(() => {
        refreshTimers.delete(query);
        if (active && query.isActive())
          invalidateFromEvent(query.queryKey, true);
      }, 0),
    );
  });
  const jobs = new QueryObserver(client, {
    queryKey: ['jobs'],
    queryFn: ({ signal }) => jobSnapshots.read(signal, eventRefresh),
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
  const updateRoom = () => {
    runInAction(() => {
      store.online.room = roomSession.getRoom();
    });
    void observeOperation(
      'errors.voiceEffects',
      roomVoiceSettings.synchronize(),
    ).catch(() => undefined);
  };
  const updateVisibility = () =>
    runInAction(() => {
      store.application.onScreen = appVisibility();
    });
  const stopJobs = jobs.subscribe(updateJobs);
  updateJobs();
  updateRoom();
  updateVisibility();
  const stopRoom = roomSession.subscribe(updateRoom);
  const stopVoiceSettings = reaction(
    () => [
      store.preferences.voiceGain,
      store.preferences.karaokeEffects,
      store.preferences.noiseSuppression,
    ],
    () => {
      void observeOperation(
        'errors.voiceEffects',
        roomVoiceSettings.preferencesChanged(),
      ).catch(() => undefined);
    },
  );
  const stopVisibility = subscribeAppVisibility(updateVisibility);
  const stopEvents = refreshOnJobChanges(() => refreshJobs(['jobs']), 250);
  const stopJobQueries = onJobChange((jobId, job) => {
    jobSnapshots.changed(jobId);
    const queryKey =
      typeof job?.type === 'string' && typeof job.entityId === 'string'
        ? ['job', job.type, job.entityId]
        : ['job'];
    refreshJobs(queryKey);
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
    active = false;
    stopRefreshes();
    pendingRefreshes.clear();
    for (const timer of refreshTimers.values()) window.clearTimeout(timer);
    refreshTimers.clear();
    stopJobs();
    jobs.destroy();
    stopEvents();
    stopJobQueries();
    stopModels();
    stopRoom();
    stopVoiceSettings();
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
  let desired = false;
  let appFocused = true;
  let minimized = false;
  let active = true;
  let transition = Promise.resolve();
  const canSuspend = () =>
    store.preferences.releaseAsioInBackground &&
    store.preferences.audio.backend === 'ASIO' &&
    store.online.room === null;
  const setSuspended = (next: boolean) => {
    if (desired === next) return;
    desired = next;
    transition = transition
      .then(async () => {
        if (!active || desired !== next || suspended === next) return;
        if (next && (!canSuspend() || recordingCoordinator.hasPendingTake())) {
          desired = false;
          return;
        }
        await (next
          ? audioClient.suspendSession()
          : audioClient.resumeSession());
        suspended = next;
      })
      .then(() => clearOperationFailure('errors.audioFocus'))
      .catch((error: unknown) => {
        suspended = false;
        desired = false;
        reportOperationFailure('errors.audioFocus', error);
      });
  };
  const syncFocus = () => {
    setSuspended(
      !appFocused &&
        canSuspend() &&
        (minimized || !settingsOpen()) &&
        !recordingCoordinator.hasPendingTake(),
    );
  };
  const stopAsio = reaction(canSuspend, syncFocus, { fireImmediately: true });
  const stopFocus = desktopClient.onAppFocus((focused) => {
    appFocused = focused;
    syncFocus();
  });
  const stopWindow = desktopClient.onWindowState?.((state) => {
    minimized = state.minimized;
    syncFocus();
  });
  return () => {
    active = false;
    stopAsio();
    stopWindow?.();
    stopFocus();
  };
};
