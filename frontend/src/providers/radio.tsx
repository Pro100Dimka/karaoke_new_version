import { observeOperation } from '../shared/errors';
import { reaction, runInAction } from 'mobx';
import { store } from './store';
import { audioClient } from '../services/audioClient';
import { sharedStateOf } from '../application/room/roomModel';
import { RoomLibraryCoordinator } from '../application/room/RoomLibraryCoordinator';
import { roomSession } from './application';
import { roomClient } from '../services/roomClient';
import type { NotificationIntent } from './notifications';
import {
  radioStations,
  youtubeSource,
  youtubeSourceFromUrl,
} from '../app/radioStations';
import { resolveYoutubeRadio } from '../services/youtubeRadio';

const publishRadio = async (enabled: boolean, stationId: string) => {
  const room = store.online.room;
  const scope = roomSession.getScope();
  if (room && scope)
    await new RoomLibraryCoordinator(scope, roomClient).publishSharedState({
      ...sharedStateOf(room),
      radioEnabled: enabled,
      radioStationId: stationId,
    });
};
export const toggleRadio = () => {
  const radio = store.radio;
  if (!radio.canControl) return;
  const enabled = !radio.enabled;
  if (
    enabled &&
    (radio.preparedKey !==
      `${store.application.services.audioEpoch}:${radio.stationId}` ||
      (youtubeSource(radio.stationId) &&
        Date.now() - radio.youtubeResolvedAt > 300_000))
  )
    runInAction(() => {
      radio.prepareRequest++;
    });
  if (store.online.room)
    void observeOperation(
      'errors.radioMetadata',
      publishRadio(enabled, radio.stationId),
    ).catch(() => undefined);
  else
    runInAction(() => {
      radio.enabled = enabled;
    });
};
export const setRadioStation = (id: string, enabled = store.radio.enabled) => {
  if (!store.radio.canControl) return;
  const youtube = youtubeSource(id);
  const current = store.radio.stationId;
  store.updatePreferences({
    radioStation: id,
    radioBroadcastStation: youtube
      ? radioStations.some((station) => station.id === current)
        ? current
        : store.preferences.radioBroadcastStation
      : id,
    ...(youtube && {
      radioYoutubePlaylist: `https://www.youtube.com/playlist?list=${youtube.playlistId}&index=${youtube.index}`,
    }),
  });
  if (store.online.room)
    void observeOperation(
      'errors.radioMetadata',
      publishRadio(enabled, id),
    ).catch(() => undefined);
  else
    runInAction(() => {
      store.radio.enabled = enabled;
    });
};
export const setYoutubePlaylist = (url: string) => {
  const source = youtubeSourceFromUrl(url);
  if (!source || !store.radio.canControl) return false;
  runInAction(() => {
    const reload = store.radio.stationId === source;
    store.updatePreferences({ radioYoutubePlaylist: url.trim() });
    setRadioStation(source, true);
    if (reload) store.radio.prepareRequest++;
  });
  return true;
};
export const changeRadioStation = (direction: 1 | -1 = 1) => {
  const source = youtubeSource(store.radio.stationId);
  if (source) {
    const track = store.radio.youtubeTrack;
    const count = track?.playlistId === source.playlistId ? track.count : 0;
    let index =
      (track?.playlistId === source.playlistId ? track.index : source.index) +
      direction;
    if (index < 1) index = count || 1;
    if (count && index > count) index = 1;
    setRadioStation(`youtube:${source.playlistId}:${index}`);
    return;
  }
  const index = radioStations.findIndex(
    (item) => item.id === store.radio.stationId,
  );
  const next =
    radioStations[
      (index + direction + radioStations.length) % radioStations.length
    ];
  if (next) setRadioStation(next.id);
};
export const setRadioVolume = (volume: number) =>
  store.updatePreferences({ radioVolume: volume });

export const subscribeRadio = (
  notify: (message: string, intent: NotificationIntent) => void,
) => {
  let joinedRoom = '';
  let preparing = 0;
  let playing = false;
  let playRequest = 0;
  const stopRoom = reaction(
    () => store.online.room,
    (room) => {
      if (!room) {
        joinedRoom = '';
        return;
      }
      if (joinedRoom !== room.code) {
        joinedRoom = room.code;
        if (room.role === 'host') {
          void observeOperation(
            'errors.radioMetadata',
            publishRadio(
              store.radio.enabled,
              store.preferences.radioStation || store.radio.stationId,
            ),
          ).catch(() => undefined);
          return;
        }
      }
      runInAction(() => {
        store.radio.enabled = Boolean(room.radioEnabled);
      });
    },
    { fireImmediately: true },
  );
  const stopPrepare = reaction(
    () =>
      [
        store.radio.libraryActive,
        store.radio.stationId,
        store.application.services.audioEpoch,
        store.radio.prepareRequest,
      ] as const,
    ([active, stationId, epoch]) => {
      const request = ++preparing;
      runInAction(() => {
        store.radio.preparedKey = '';
        store.radio.error = false;
        store.radio.loading = active;
        store.radio.youtubeTrack = null;
      });
      playing = false;
      const station = radioStations.find((item) => item.id === stationId);
      const youtube = youtubeSource(stationId);
      if (!active || (!station && !youtube)) {
        runInAction(() => {
          store.radio.loading = false;
        });
        void observeOperation(
          'errors.radioStop',
          audioClient.stopRadio(),
        ).catch(() => undefined);
        return;
      }
      void (async () => {
        try {
          await audioClient.stopRadio();
          if (request !== preparing) return;
          await audioClient.setRadioGain(store.radio.volume / 100);
          if (request !== preparing) return;
          let url = station?.url;
          if (youtube) {
            const track = await resolveYoutubeRadio(
              youtube.playlistId,
              youtube.index,
            );
            if (request !== preparing) return;
            runInAction(() => {
              store.radio.youtubeTrack = track;
              store.radio.youtubeResolvedAt = Date.now();
            });
            url = track.url;
          }
          if (!url) return;
          await audioClient.loadRadio(url);
          if (request === preparing)
            runInAction(() => {
              store.radio.preparedKey = `${epoch}:${stationId}`;
              store.radio.loading = false;
            });
        } catch {
          if (request !== preparing) return;
          runInAction(() => {
            store.radio.loading = false;
            store.radio.error = true;
          });
          if (!store.radio.enabled) return;
          if (!store.online.room)
            runInAction(() => {
              store.radio.enabled = false;
            });
          notify(
            youtube ? 'radioYoutubeUnavailable' : 'radioUnavailable',
            'error',
          );
        }
      })();
    },
    { fireImmediately: true },
  );
  const stopPlay = reaction(
    () =>
      [
        store.radio.libraryActive,
        store.radio.enabled,
        store.radio.preparedKey,
        store.application.services.audioEpoch,
        store.radio.stationId,
      ] as const,
    ([active, enabled, prepared, epoch, station]) => {
      const request = ++playRequest;
      if (!active) return;
      if (!enabled) {
        if (playing) {
          playing = false;
          void observeOperation(
            'errors.radioPause',
            audioClient.pauseRadio(),
          ).catch(() => undefined);
        }
        return;
      }
      if (prepared !== `${epoch}:${station}`) return;
      playing = true;
      void audioClient.playRadio().catch(() => {
        if (request !== playRequest) return;
        playing = false;
        runInAction(() => {
          store.radio.preparedKey = '';
          store.radio.error = true;
        });
        if (!store.online.room)
          runInAction(() => {
            store.radio.enabled = false;
          });
        notify('radioUnavailable', 'error');
      });
    },
    { fireImmediately: true },
  );
  const stopVolume = reaction(
    () => [store.radio.libraryActive, store.radio.volume] as const,
    ([active, volume]) => {
      if (active)
        void observeOperation(
          'errors.radioVolume',
          audioClient.setRadioGain(volume / 100),
        ).catch(() => undefined);
    },
    { fireImmediately: true },
  );
  let trackEndTimer: ReturnType<typeof setInterval> | undefined;
  const stopPlaylist = reaction(
    () =>
      Boolean(
        youtubeSource(store.radio.stationId) &&
        store.radio.libraryActive &&
        store.radio.enabled &&
        store.radio.preparedKey ===
          `${store.application.services.audioEpoch}:${store.radio.stationId}` &&
        (!store.online.room || store.online.room.role === 'host'),
      ),
    (active) => {
      clearInterval(trackEndTimer);
      if (!active) return;
      const generation = preparing;
      let pending = false;
      trackEndTimer = setInterval(() => {
        if (pending) return;
        pending = true;
        void audioClient
          .diagnosticsDump()
          .then((values) => {
            if (generation === preparing && values.RadioState === '6')
              changeRadioStation();
          })
          .catch(() => undefined)
          .finally(() => {
            pending = false;
          });
      }, 750);
    },
    { fireImmediately: true },
  );
  return () => {
    stopRoom();
    stopPrepare();
    stopPlay();
    stopVolume();
    stopPlaylist();
    clearInterval(trackEndTimer);
    preparing++;
    playRequest++;
    runInAction(() => {
      store.radio.preparedKey = '';
      store.radio.loading = false;
    });
    void observeOperation('errors.radioStop', audioClient.stopRadio()).catch(
      () => undefined,
    );
  };
};
