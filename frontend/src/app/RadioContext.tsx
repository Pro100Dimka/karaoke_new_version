import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { audioClient } from "../services/audioClient";
import { sharedStateOf } from "../application/room/roomModel";
import { useApp, useRoomLibraryCommands } from "./AppContext";
import { useNotify } from "./NotificationsProvider";
import { radioStations } from "./radioStations";
import { useServices } from "./ServicesContext";

export interface RadioContextValue {
  enabled: boolean;
  stationId: string;
  volume: number;
  canControl: boolean;
  toggle(): void;
  setStation(id: string): void;
  setVolume(value: number): void;
}

const RadioContext = createContext<RadioContextValue | null>(null);

/** Radio is a Library-only listening feature executed by AudioService; it never plays alongside Karaoke or the editor. */
export const RadioProvider = ({
  libraryActive,
  children,
}: {
  libraryActive: boolean;
  children: ReactNode;
}) => {
  const { preferences, updatePreferences, room } = useApp();
  const roomLibrary = useRoomLibraryCommands();
  const notify = useNotify();
  const { audioEpoch } = useServices();
  const [enabled, setEnabled] = useState(Boolean(room?.radioEnabled));
  const [preparedStationKey, setPreparedStationKey] = useState("");
  const [prepareRequest, setPrepareRequest] = useState(0);
  const requestedStation = room?.radioStationId ?? preferences.radioStation;
  const stationId = radioStations.some((item) => item.id === requestedStation)
    ? requestedStation
    : (radioStations[0]?.id ?? "");
  const volume = preferences.radioVolume;
  const stationKey = `${audioEpoch}:${stationId}`;
  const canControl =
    !room || room.role === "host" || Boolean(room.collaborativeControl);
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
        void roomLibrary
          ?.publishSharedState({
            ...sharedStateOf(room),
            radioEnabled: enabledRef.current,
            radioStationId: preferences.radioStation,
          })
          .catch(() => undefined);
        return;
      }
    }
    setEnabled(Boolean(room.radioEnabled));
  }, [
    room?.code,
    room?.role,
    room?.radioEnabled,
    room?.radioStationId,
    room?.libraryQuery,
    room?.libraryStatus,
    room?.librarySort,
    preferences.radioStation,
    roomLibrary,
  ]);

  // Keep the selected stream decoded and ready while the Library is visible. The radio button can
  // then start an already-buffered source instead of waiting for a new HTTPS connection.
  useEffect(() => {
    const station = radioStations.find((item) => item.id === stationId);
    if (!libraryActive || !station) {
      setPreparedStationKey("");
      playingRef.current = false;
      void audioClient.stopRadio().catch(() => undefined);
      return;
    }
    let cancelled = false;
    setPreparedStationKey("");
    playingRef.current = false;
    void (async () => {
      try {
        await audioClient.setRadioGain(volumeRef.current / 100);
        await audioClient.loadRadio(station.url);
        if (!cancelled) setPreparedStationKey(stationKey);
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
  }, [libraryActive, stationId, stationKey, prepareRequest, notify]);

  useEffect(() => {
    if (!libraryActive) return;
    if (!enabled) {
      if (playingRef.current) {
        playingRef.current = false;
        void audioClient.pauseRadio().catch(() => undefined);
      }
      return;
    }
    if (preparedStationKey !== stationKey) return;
    let cancelled = false;
    // Native commands are serialized: off must enqueue Pause even before Play acknowledges.
    playingRef.current = true;
    void audioClient
      .playRadio()
      .catch(() => {
        if (cancelled) return;
        playingRef.current = false;
        if (!roomRef.current) setEnabled(false);
        notify("Radio unavailable", "error");
      });
    return () => { cancelled = true; };
  }, [enabled, libraryActive, preparedStationKey, stationKey, notify]);

  useEffect(() => {
    if (libraryActive)
      void audioClient.setRadioGain(volume / 100).catch(() => undefined);
  }, [libraryActive, volume]);

  const publishRoomRadio = useCallback(
    async (radioEnabled: boolean, radioStationId: string) => {
      const room = roomRef.current;
      if (!room) return;
      await roomLibrary?.publishSharedState({
        ...sharedStateOf(room),
        radioEnabled,
        radioStationId,
      });
    },
    [roomLibrary],
  );

  const toggle = useCallback(() => {
    if (!canControl) return;
    const next = !enabled;
    if (next && preparedStationKey !== stationKey)
      setPrepareRequest((request) => request + 1);
    if (roomRef.current) void publishRoomRadio(next, stationId);
    else setEnabled(next);
  }, [canControl, enabled, publishRoomRadio, stationId, preparedStationKey, stationKey]);
  const value = useMemo<RadioContextValue>(
    () => ({
      enabled,
      stationId,
      volume,
      canControl,
      toggle,
      setStation: (id) => {
        if (!canControl) return;
        updatePreferences({ radioStation: id });
        if (roomRef.current) void publishRoomRadio(enabled, id);
      },
      setVolume: (next) => updatePreferences({ radioVolume: next }),
    }),
    [
      enabled,
      stationId,
      volume,
      canControl,
      toggle,
      updatePreferences,
      publishRoomRadio,
    ],
  );
  return (
    <RadioContext.Provider value={value}>{children}</RadioContext.Provider>
  );
};

export const useRadio = (): RadioContextValue => {
  const value = useContext(RadioContext);
  if (!value) throw new Error("useRadio must be used inside RadioProvider");
  return value;
};
