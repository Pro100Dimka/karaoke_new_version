import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { audioClient } from "../services/audioClient";
import { roomClient } from "../services/roomClient";
import { useApp } from "./AppContext";
import { useNotify } from "./NotificationsProvider";
import { radioStations } from "./radioStations";

interface RadioContextValue {
  enabled: boolean;
  stationId: string;
  volume: number;
  toggle(): void;
  setStation(id: string): void;
  setVolume(value: number): void;
}

const RadioContext = createContext<RadioContextValue | null>(null);

/** Radio is a Library-only listening feature executed by AudioService; it never plays alongside Karaoke or the editor. */
export const RadioProvider = ({ libraryActive, children }: { libraryActive: boolean; children: ReactNode }) => {
  const { preferences, updatePreferences, room, setRoom } = useApp();
  const notify = useNotify();
  const [enabled, setEnabled] = useState(Boolean(room?.radioEnabled));
  const [preparedStationId, setPreparedStationId] = useState("");
  const [prepareRequest, setPrepareRequest] = useState(0);
  const requestedStation = room?.radioStationId ?? preferences.radioStation;
  const stationId = radioStations.some(item => item.id === requestedStation)
    ? requestedStation
    : (radioStations[0]?.id ?? "");
  const volume = preferences.radioVolume;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const roomRef = useRef(room);
  roomRef.current = room;
  const playingRef = useRef(false);
  const joinedRoomRef = useRef("");
  // The stream is not reloaded on volume changes, so the effect reads the latest volume from a ref.
  const volumeRef = useRef(volume);
  volumeRef.current = volume;

  useEffect(() => {
    if (!room) {
      joinedRoomRef.current = "";
      return;
    }
    if (joinedRoomRef.current !== room.code) {
      joinedRoomRef.current = room.code;
      if (room.role === "host") {
        void roomClient.updateSharedState(room.code, {
          radioEnabled: enabledRef.current,
          radioStationId: preferences.radioStation,
          libraryQuery: room.libraryQuery ?? "",
          libraryStatus: room.libraryStatus ?? "all",
          librarySort: room.librarySort ?? "recent",
          playbackRate: room.playbackRate ?? 1,
          keyShift: room.keyShift ?? 0
        }).then(setRoom).catch(() => undefined);
        return;
      }
    }
    setEnabled(Boolean(room.radioEnabled));
  }, [room?.code, room?.role, room?.radioEnabled, room?.radioStationId, room?.libraryQuery, room?.libraryStatus, room?.librarySort, preferences.radioStation, setRoom]);

  // Keep the selected stream decoded and ready while the Library is visible. The radio button can
  // then start an already-buffered source instead of waiting for a new HTTPS connection.
  useEffect(() => {
    const station = radioStations.find(item => item.id === stationId);
    if (!libraryActive || !station) {
      setPreparedStationId("");
      playingRef.current = false;
      void audioClient.stopRadio().catch(() => undefined);
      return;
    }
    let cancelled = false;
    setPreparedStationId(current => current === station.id ? current : "");
    void (async () => {
      try {
        await audioClient.setRadioGain(volumeRef.current / 100);
        await audioClient.loadRadio(station.url);
        if (!cancelled) setPreparedStationId(station.id);
      } catch {
        if (!cancelled && enabledRef.current) {
          if (!roomRef.current) setEnabled(false);
          notify("Radio unavailable", "error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [libraryActive, stationId, prepareRequest, notify]);

  useEffect(() => {
    if (!libraryActive) return;
    if (!enabled) {
      if (playingRef.current) {
        playingRef.current = false;
        void audioClient.pauseRadio().catch(() => undefined);
      }
      return;
    }
    if (preparedStationId !== stationId) {
      setPrepareRequest(request => request + 1);
      return;
    }
    void audioClient.playRadio()
      .then(() => { playingRef.current = true; })
      .catch(() => {
        if (!roomRef.current) setEnabled(false);
        notify("Radio unavailable", "error");
      });
  }, [enabled, libraryActive, preparedStationId, stationId, notify]);

  useEffect(() => {
    if (libraryActive) void audioClient.setRadioGain(volume / 100).catch(() => undefined);
  }, [libraryActive, volume]);

  const publishRoomRadio = useCallback(async (radioEnabled: boolean, radioStationId: string) => {
    if (!room) return;
    const updated = await roomClient.updateSharedState(room.code, {
      radioEnabled,
      radioStationId,
      libraryQuery: room.libraryQuery ?? "",
      libraryStatus: room.libraryStatus ?? "all",
      librarySort: room.librarySort ?? "recent",
      playbackRate: room.playbackRate ?? 1,
      keyShift: room.keyShift ?? 0
    });
    setRoom(updated);
  }, [room, setRoom]);

  const toggle = useCallback(() => {
    const next = !enabled;
    if (room) void publishRoomRadio(next, stationId);
    else setEnabled(next);
  }, [enabled, room, publishRoomRadio, stationId]);
  const value = useMemo<RadioContextValue>(
    () => ({
      enabled,
      stationId,
      volume,
      toggle,
      setStation: id => {
        updatePreferences({ radioStation: id });
        if (room) void publishRoomRadio(enabled, id);
      },
      setVolume: next => updatePreferences({ radioVolume: next })
    }),
    [enabled, stationId, volume, toggle, updatePreferences, room, publishRoomRadio]
  );
  return <RadioContext.Provider value={value}>{children}</RadioContext.Provider>;
};

export const useRadio = (): RadioContextValue => {
  const value = useContext(RadioContext);
  if (!value) throw new Error("useRadio must be used inside RadioProvider");
  return value;
};
