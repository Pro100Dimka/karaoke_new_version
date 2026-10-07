import { createContext, useContext, type ReactNode } from "react";
import type {
  KaraokeAudioPort, KaraokeBackendPort, KaraokeLightingPort,
  KaraokeRecordingPort, KaraokeScenePort,
} from "../application/karaoke/KaraokePorts";
import { audioClient, getAudioSnapshot } from "../services/audioClient";
import { desktopClient } from "../services/desktopClient";
import { keyboardLightingClient } from "../services/keyboardLightingClient";
import { pythonClient } from "../services/pythonClient";
import { recordingCoordinator } from "../services/recordingCoordinator";

const ports: {
  audio: KaraokeAudioPort;
  backend: KaraokeBackendPort;
  recording: KaraokeRecordingPort;
  scene: KaraokeScenePort;
  lighting: KaraokeLightingPort;
} = {
  audio: { ...audioClient, snapshot: () => getAudioSnapshot() },
  backend: pythonClient,
  recording: recordingCoordinator,
  scene: desktopClient,
  lighting: keyboardLightingClient,
};
const KaraokeContext = createContext<typeof ports | null>(null);

export const KaraokeProvider = ({ children }: { children: ReactNode }) =>
  <KaraokeContext.Provider value={ports}>{children}</KaraokeContext.Provider>;

const useKaraokePorts = (): typeof ports => {
  const value = useContext(KaraokeContext);
  if (!value) throw new Error("KaraokeProvider is missing");
  return value;
};

export const useKaraokeAudio = (): KaraokeAudioPort => useKaraokePorts().audio;
export const useKaraokeBackend = (): KaraokeBackendPort => useKaraokePorts().backend;
export const useKaraokeRecording = (): KaraokeRecordingPort => useKaraokePorts().recording;
export const useKaraokeScene = (): KaraokeScenePort => useKaraokePorts().scene;
export const useKaraokeLighting = (): KaraokeLightingPort => useKaraokePorts().lighting;
