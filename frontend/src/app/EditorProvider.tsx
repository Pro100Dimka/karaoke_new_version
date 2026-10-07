import { createContext, useContext, type ReactNode } from "react";
import type {
  EditorAudioPort, EditorBackendPort, EditorRepository,
} from "../application/editor/EditorPorts";
import { createEditorApi } from "../features/editor/editorApi";
import { audioClient, getAudioSnapshot } from "../services/audioClient";
import { bridgedHttp } from "../services/desktopBridge";
import { pythonClient } from "../services/pythonClient";

const ports: {
  audio: EditorAudioPort;
  backend: EditorBackendPort;
  repository: EditorRepository;
} = {
  audio: { ...audioClient, snapshot: () => getAudioSnapshot() },
  backend: pythonClient,
  repository: createEditorApi((request) =>
    bridgedHttp("pythonRequest", request, "Editor backend request failed")),
};
const EditorContext = createContext<typeof ports | null>(null);

export const EditorProvider = ({ children }: { children: ReactNode }) =>
  <EditorContext.Provider value={ports}>{children}</EditorContext.Provider>;

const useEditorPorts = (): typeof ports => {
  const value = useContext(EditorContext);
  if (!value) throw new Error("EditorProvider is missing");
  return value;
};

export const useEditorAudio = (): EditorAudioPort => useEditorPorts().audio;
export const useEditorBackend = (): EditorBackendPort => useEditorPorts().backend;
export const useEditorRepository = (): EditorRepository => useEditorPorts().repository;
