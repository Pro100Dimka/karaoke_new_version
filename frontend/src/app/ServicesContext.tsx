import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { audioClient } from "../services/audioClient";
import { pythonClient } from "../services/pythonClient";
import { isReady, pythonStatusFrom, reconnected, withStartupGrace, type ServiceStatus } from "./serviceStatus";

interface ServicesContextValue {
  python: ServiceStatus;
  audio: ServiceStatus;
  /** Increments whenever a service returns after an outage; data views refetch on change. */
  pythonEpoch: number;
  audioEpoch: number;
  probe(): Promise<void>;
}

const ServicesContext = createContext<ServicesContextValue | null>(null);
const steadyProbeMilliseconds = 4000;
const startupProbeMilliseconds = 1000;

export const ServicesProvider = ({ children }: { children: ReactNode }) => {
  const [python, setPython] = useState<ServiceStatus>({ kind: "starting" });
  const [audio, setAudio] = useState<ServiceStatus>({ kind: "starting" });
  const [pythonEpoch, setPythonEpoch] = useState(0);
  const [audioEpoch, setAudioEpoch] = useState(0);
  const pythonRef = useRef(python);
  const audioRef = useRef(audio);
  const launchedAt = useRef(Date.now());
  const pythonSeenReady = useRef(false);
  const audioSeenReady = useRef(false);

  const probe = useCallback(async () => {
    const [probedPython, probedAudio] = await Promise.all([
      pythonClient
        .health()
        .then(pythonStatusFrom)
        .catch((): ServiceStatus => ({ kind: "unavailable" })),
      audioClient
        .health()
        .then((result): ServiceStatus =>
          result.status === "ready" ? { kind: "ready", version: result.version } : { kind: "unavailable" }
        )
        .catch((): ServiceStatus => ({ kind: "unavailable" }))
    ]);
    const elapsed = Date.now() - launchedAt.current;
    const nextPython = withStartupGrace(probedPython, pythonSeenReady.current, elapsed);
    const nextAudio = withStartupGrace(probedAudio, audioSeenReady.current, elapsed);
    pythonSeenReady.current ||= isReady(nextPython);
    audioSeenReady.current ||= isReady(nextAudio);
    if (reconnected(pythonRef.current, nextPython)) setPythonEpoch(value => value + 1);
    if (reconnected(audioRef.current, nextAudio)) setAudioEpoch(value => value + 1);
    pythonRef.current = nextPython;
    audioRef.current = nextAudio;
    setPython(nextPython);
    setAudio(nextAudio);
  }, []);

  const settled = isReady(python) && isReady(audio);
  useEffect(() => {
    void probe();
    const timer = window.setInterval(() => void probe(), settled ? steadyProbeMilliseconds : startupProbeMilliseconds);
    return () => window.clearInterval(timer);
  }, [probe, settled]);

  const value = useMemo(
    () => ({ python, audio, pythonEpoch, audioEpoch, probe }),
    [python, audio, pythonEpoch, audioEpoch, probe]
  );
  return <ServicesContext.Provider value={value}>{children}</ServicesContext.Provider>;
};

export const useServices = (): ServicesContextValue => {
  const value = useContext(ServicesContext);
  if (!value) throw new Error("useServices must be used inside ServicesProvider");
  return value;
};
