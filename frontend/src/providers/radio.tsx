import { reaction, runInAction } from "mobx";
import { store } from "./store";
import { audioClient } from "../services/audioClient";
import { sharedStateOf } from "../application/room/roomModel";
import { RoomLibraryCoordinator } from "../application/room/RoomLibraryCoordinator";
import { roomSession } from "./application";
import { roomClient } from "../services/roomClient";
import type { NotificationIntent } from "./notifications";
import { radioStations } from "../app/radioStations";

const publishRadio = async (enabled: boolean, stationId: string) => {
  const room = store.online.room;
  const scope = roomSession.getScope();
  if (room && scope) await new RoomLibraryCoordinator(scope, roomClient).publishSharedState({
    ...sharedStateOf(room), radioEnabled: enabled, radioStationId: stationId,
  });
};
export const toggleRadio = () => {
  const radio = store.radio;
  if (!radio.canControl) return;
  const enabled = !radio.enabled;
  if (enabled && radio.preparedKey !== `${store.application.services.audioEpoch}:${radio.stationId}`)
    runInAction(() => { radio.prepareRequest++; });
  if (store.online.room) void publishRadio(enabled, radio.stationId);
  else runInAction(() => { radio.enabled = enabled; });
};
export const setRadioStation = (id: string) => {
  if (!store.radio.canControl) return;
  store.updatePreferences({ radioStation: id });
  if (store.online.room) void publishRadio(store.radio.enabled, id);
};
export const setRadioVolume = (volume: number) => store.updatePreferences({ radioVolume: volume });

export const subscribeRadio = (notify: (message: string, intent: NotificationIntent) => void) => {
  let joinedRoom = "";
  let preparing = 0;
  let playing = false;
  let playRequest = 0;
  const stopRoom = reaction(() => store.online.room, room => {
    if (!room) { joinedRoom = ""; return; }
    if (joinedRoom !== room.code) {
      joinedRoom = room.code;
      if (room.role === "host") {
        void publishRadio(store.radio.enabled, store.preferences.radioStation).catch(() => undefined);
        return;
      }
    }
    runInAction(() => { store.radio.enabled = Boolean(room.radioEnabled); });
  }, { fireImmediately: true });
  const stopPrepare = reaction(() => [store.radio.libraryActive, store.radio.stationId,
    store.application.services.audioEpoch, store.radio.prepareRequest] as const,
    ([active, stationId, epoch]) => {
      const request = ++preparing;
      runInAction(() => { store.radio.preparedKey = ""; });
      playing = false;
      const station = radioStations.find(item => item.id === stationId);
      if (!active || !station) { void audioClient.stopRadio().catch(() => undefined); return; }
      void (async () => {
        try {
          await audioClient.setRadioGain(store.radio.volume / 100);
          if (request !== preparing) return;
          await audioClient.loadRadio(station.url);
          if (request === preparing) runInAction(() => { store.radio.preparedKey = `${epoch}:${stationId}`; });
        } catch {
          if (request !== preparing || !store.radio.enabled) return;
          if (!store.online.room) runInAction(() => { store.radio.enabled = false; });
          notify("Radio unavailable", "error");
        }
      })();
    }, { fireImmediately: true });
  const stopPlay = reaction(() => [store.radio.libraryActive, store.radio.enabled,
    store.radio.preparedKey, store.application.services.audioEpoch, store.radio.stationId] as const,
    ([active, enabled, prepared, epoch, station]) => {
      const request = ++playRequest;
      if (!active) return;
      if (!enabled) {
        if (playing) { playing = false; void audioClient.pauseRadio().catch(() => undefined); }
        return;
      }
      if (prepared !== `${epoch}:${station}`) return;
      playing = true;
      void audioClient.playRadio().catch(() => {
        if (request !== playRequest) return;
        playing = false;
        if (!store.online.room) runInAction(() => { store.radio.enabled = false; });
        notify("Radio unavailable", "error");
      });
    }, { fireImmediately: true });
  const stopVolume = reaction(() => [store.radio.libraryActive, store.radio.volume] as const,
    ([active, volume]) => { if (active) void audioClient.setRadioGain(volume / 100).catch(() => undefined); },
    { fireImmediately: true });
  return () => {
    stopRoom(); stopPrepare(); stopPlay(); stopVolume(); preparing++; playRequest++;
    runInAction(() => { store.radio.preparedKey = ""; });
    void audioClient.stopRadio().catch(() => undefined);
  };
};
