/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEMO_MODE?: "true" | "false";
}
interface ImportMeta { readonly env: ImportMetaEnv; }

interface PythonBridgeRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

interface PythonBridgeResponse {
  status: number;
  ok: boolean;
  body: unknown;
}

interface AudioBridgeRequest {
  command: string;
  args?: Record<string, string | number | boolean | undefined>;
}

interface AudioBridgeResponse {
  status: number;
  text: string;
}

interface WaveInfo {
  sampleRate: number;
  channels: number;
  durationSeconds: number;
}

interface ProjectArtifacts {
  instrumental: string;
  vocals?: string;
  lyricsSync?: string;
}

interface DesktopApi {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<boolean>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  pickAudioFile(): Promise<string | null>;
  revealInExplorer(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  copyText(value: string): Promise<void>;
  pythonRequest(request: PythonBridgeRequest): Promise<PythonBridgeResponse>;
  audioRequest(request: AudioBridgeRequest): Promise<AudioBridgeResponse>;
  waveformPeaks(songId: string, revision: number, bins: number): Promise<number[]>;
  recordingPeaks(recordingId: string, bins: number): Promise<number[]>;
  resolveProjectArtifacts(songId: string, revision: number): Promise<ProjectArtifacts>;
  revealProject(songId: string, revision: number): Promise<void>;
  inspectWave(path: string): Promise<WaveInfo>;
  setAppIcon(theme: string): Promise<void>;
  appReady(): Promise<void>;
  sceneVideoUrl(): Promise<string | null>;
  pickImageFile(): Promise<string | null>;
  statFile(path: string): Promise<FileInfo>;
  pathForFile(file: File): string;
  toggleFullscreen(): Promise<boolean>;
  isFullscreen(): Promise<boolean>;
  saveTextFile(defaultName: string, content: string): Promise<boolean>;
  openMicrophonePrivacy(): Promise<void>;
  confirmClose(): Promise<void>;
  onCloseRequested(listener: () => void): () => void;
  onWindowState(listener: (state: WindowState) => void): () => void;
}
interface FileInfo { name: string; extension: string; sizeBytes: number; }
interface WindowState { maximized: boolean; fullscreen: boolean; }
interface Window { desktop?: DesktopApi; }
