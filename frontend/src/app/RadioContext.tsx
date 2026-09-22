import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { audioClient } from "../services/audioClient";
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
  const { preferences, updatePreferences } = useApp();
  const notify = useNotify();
  const [enabled, setEnabled] = useState(false);
  const [preparedStationId, setPreparedStationId] = useState("");
  const [prepareRequest, setPrepareRequest] = useState(0);
  const stationId = radioStations.some(item => item.id === preferences.radioStation)
    ? preferences.radioStation
    : (radioStations[0]?.id ?? "");
  const volume = preferences.radioVolume;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const playingRef = useRef(false);
  // The stream is not reloaded on volume changes, so the effect reads the latest volume from a ref.
  const volumeRef = useRef(volume);
  volumeRef.current = volume;

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
          setEnabled(false);
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
        setEnabled(false);
        notify("Radio unavailable", "error");
      });
  }, [enabled, libraryActive, preparedStationId, stationId, notify]);

  useEffect(() => {
    if (libraryActive) void audioClient.setRadioGain(volume / 100).catch(() => undefined);
  }, [libraryActive, volume]);

  const toggle = useCallback(() => setEnabled(value => !value), []);
  const value = useMemo<RadioContextValue>(
    () => ({
      enabled,
      stationId,
      volume,
      toggle,
      setStation: id => updatePreferences({ radioStation: id }),
      setVolume: next => updatePreferences({ radioVolume: next })
    }),
    [enabled, stationId, volume, toggle, updatePreferences]
  );
  return <RadioContext.Provider value={value}>{children}</RadioContext.Provider>;
};

export const useRadio = (): RadioContextValue => {
  const value = useContext(RadioContext);
  if (!value) throw new Error("useRadio must be used inside RadioProvider");
  return value;
};
