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
  melody?: string;
  lyricsSync?: string;
}

interface DesktopApi {
  readonly roomE2e?: boolean;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<boolean>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  pickAudioFile(): Promise<string | null>;
  getStorageRoot(): Promise<string>;
  pickStorageFolder(current?: string): Promise<string | null>;
  setStorageRoot(path: string): Promise<void>;
  revealInExplorer(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  copyText(value: string): Promise<void>;
  pythonRequest(request: PythonBridgeRequest): Promise<PythonBridgeResponse>;
  /** Same shape as pythonRequest, but reaches the shared room/voice server instead of the local Python backend. */
  roomRequest(request: PythonBridgeRequest): Promise<PythonBridgeResponse>;
  /** Starts this participant's voice session against the room server's relay; the server address stays in Electron Main. */
  joinRoomVoice(roomId: string, participantId: string): Promise<void>;
  leaveRoomVoice(): Promise<void>;
  /** Latest microphone level of every participant, measured before the central mix-minus. */
  roomVoiceLevels(): Promise<Record<string, number>>;
  setRoomVoiceParticipantGain(participantId: string, gain: number): Promise<void>;
  keyboardLightingCapabilities(): Promise<KeyboardLightingCapabilities>;
  setKeyboardLighting(request: KeyboardLightingRequest): Promise<void>;
  uploadRoomProject(request: RoomProjectTransferRequest & { path: string }): Promise<void>;
  downloadRoomProject(request: RoomProjectTransferRequest): Promise<string>;
  cancelRoomProjectTransfer(transferId: string): Promise<void>;
  releaseRoomProjectDownload(path: string): Promise<void>;
  onRoomProjectTransferProgress(listener: (progress: RoomProjectTransferProgress) => void): () => void;
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
  installAsio4All(): Promise<void>;
  relaunchApp(): Promise<void>;
  confirmClose(): Promise<void>;
  onCloseRequested(listener: () => void): () => void;
  onWindowState(listener: (state: WindowState) => void): () => void;
  /** Tells the room server this app's name and room; sent over the friends socket only when they change. */
  socialPresence(presence: SocialPresenceUpdate): Promise<void>;
  /** This profile's room participant id, derived from its private room key by the main process. */
  readonly roomParticipantId: string;
  /** The last inbox the server pushed, or `{ type: "offline" }`. */
  socialLatest(): Promise<unknown>;
  onSocialInbox(listener: (message: unknown) => void): () => void;
  onBackendEvent(listener: (event: unknown) => void): () => void;
  onAppVisibility(listener: (onScreen: boolean) => void): () => void;
}
interface SocialPresenceUpdate { displayName: string; participantId: string | null; roomId: string | null; }
interface KeyboardLightingCapabilities { available: boolean; provider?: "OpenRGB"; deviceCount: number; }
interface KeyboardLightingRequest { enabled: boolean; brightness: number; color: string; }
interface FileInfo { name: string; extension: string; sizeBytes: number; }
interface RoomProjectTransferRequest { roomId: string; participantId: string; songId: string; revision: number; transferId?: string; }
interface RoomProjectTransferProgress { transferId: string; direction: "upload" | "download"; transferredBytes: number; totalBytes: number; }
interface WindowState { maximized: boolean; fullscreen: boolean; minimized: boolean; }
interface Window {
  desktop?: DesktopApi;
  roomE2eReconnectVoiceSession?: () => Promise<void>;
}
