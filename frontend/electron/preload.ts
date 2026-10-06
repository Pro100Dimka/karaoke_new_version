import { contextBridge, ipcRenderer, webUtils } from "electron";
import { ipcChannels, roomParticipantArgument } from "./ipcChannels";

const desktopApi = {
  roomE2e: process.env.AD_VOICE_ROOM_E2E === "1",
  minimize: (): Promise<void> => ipcRenderer.invoke(ipcChannels.minimize),

  toggleMaximize: (): Promise<boolean> =>
    ipcRenderer.invoke(ipcChannels.toggleMaximize),

  close: (): Promise<void> => ipcRenderer.invoke(ipcChannels.close),

  isMaximized: (): Promise<boolean> =>
    ipcRenderer.invoke(ipcChannels.isMaximized),

  pickAudioFile: (): Promise<string | null> =>
    ipcRenderer.invoke(ipcChannels.pickAudioFile),

  getStorageRoot: (): Promise<string> =>
    ipcRenderer.invoke(ipcChannels.getStorageRoot),

  pickStorageFolder: (current?: string): Promise<string | null> =>
    ipcRenderer.invoke(ipcChannels.pickStorageFolder, current),

  setStorageRoot: (path: string): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.setStorageRoot, path),

  revealInExplorer: (path: string): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.reveal, path),

  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.openExternal, url),

  copyText: (value: string): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.copyText, value),

  pythonRequest: (request: unknown): Promise<unknown> =>
    ipcRenderer.invoke(ipcChannels.pythonRequest, request),

  roomRequest: (request: unknown): Promise<unknown> =>
    ipcRenderer.invoke(ipcChannels.roomRequest, request),

  joinRoomVoice: (roomId: string, participantId: string): Promise<unknown> =>
    ipcRenderer.invoke(ipcChannels.joinRoomVoice, { roomId, participantId }),

  leaveRoomVoice: (): Promise<unknown> =>
    ipcRenderer.invoke(ipcChannels.leaveRoomVoice),

  roomVoiceLevels: (): Promise<unknown> =>
    ipcRenderer.invoke(ipcChannels.roomVoiceLevels),

  setRoomVoiceParticipantGain: (participantId: string, gain: number): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.setRoomVoiceParticipantGain, { participantId, gain }),

  keyboardLightingCapabilities: (): Promise<unknown> =>
    ipcRenderer.invoke(ipcChannels.keyboardLightingCapabilities),
  setKeyboardLighting: (request: unknown): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.setKeyboardLighting, request),

  uploadRoomProject: (request: unknown): Promise<unknown> =>
    ipcRenderer.invoke(ipcChannels.uploadRoomProject, request),

  downloadRoomProject: (request: unknown): Promise<unknown> =>
    ipcRenderer.invoke(ipcChannels.downloadRoomProject, request),
  cancelRoomProjectTransfer: (transferId: string): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.cancelRoomProjectTransfer, transferId),
  releaseRoomProjectDownload: (path: string): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.releaseRoomProjectDownload, path),
  onRoomProjectTransferProgress: (listener: (progress: unknown) => void): (() => void) => {
    const callback = (_event: Electron.IpcRendererEvent, progress: unknown) => listener(progress);
    ipcRenderer.on(ipcChannels.roomProjectTransferProgress, callback);
    return () => ipcRenderer.removeListener(ipcChannels.roomProjectTransferProgress, callback);
  },

  audioRequest: (request: unknown): Promise<unknown> =>
    ipcRenderer.invoke(ipcChannels.audioRequest, request),

  waveformPeaks: (songId: string, revision: number, bins: number): Promise<unknown> =>
    ipcRenderer.invoke(ipcChannels.waveformPeaks, { songId, revision, bins }),

  recordingPeaks: (recordingId: string, bins: number): Promise<unknown> =>
    ipcRenderer.invoke(ipcChannels.recordingPeaks, { recordingId, bins }),

  resolveProjectArtifacts: (
    songId: string,
    revision: number,
  ): Promise<unknown> =>
    ipcRenderer.invoke(ipcChannels.resolveProjectArtifacts, {
      songId,
      revision,
    }),

  revealProject: (songId: string, revision: number): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.revealProject, {
      songId,
      revision,
    }),

  inspectWave: (path: string): Promise<unknown> =>
    ipcRenderer.invoke(ipcChannels.inspectWave, path),

  appReady: (): Promise<void> => ipcRenderer.invoke(ipcChannels.appReady),

  setAppIcon: (theme: string): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.setAppIcon, theme),

  sceneVideoUrl: (): Promise<string | null> =>
    ipcRenderer.invoke(ipcChannels.sceneVideoUrl),

  pickImageFile: (): Promise<string | null> =>
    ipcRenderer.invoke(ipcChannels.pickImageFile),

  statFile: (path: string): Promise<unknown> =>
    ipcRenderer.invoke(ipcChannels.statFile, path),

  pathForFile: (file: File): string => webUtils.getPathForFile(file),

  toggleFullscreen: (): Promise<boolean> =>
    ipcRenderer.invoke(ipcChannels.toggleFullscreen),

  isFullscreen: (): Promise<boolean> =>
    ipcRenderer.invoke(ipcChannels.isFullscreen),

  saveTextFile: (defaultName: string, content: string): Promise<boolean> =>
    ipcRenderer.invoke(ipcChannels.saveTextFile, { defaultName, content }),

  openMicrophonePrivacy: (): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.openMicrophonePrivacy),
  installAsio4All: (): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.installAsio4All),
  relaunchApp: (): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.relaunchApp),

  confirmClose: (): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.confirmClose),

  onCloseRequested: (listener: () => void): (() => void) => {
    const handler = (): void => listener();
    ipcRenderer.on(ipcChannels.closeRequested, handler);
    return () => ipcRenderer.removeListener(ipcChannels.closeRequested, handler);
  },

  socialPresence: (presence: { displayName: string; participantId: string | null; roomId: string | null }): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.socialPresence, presence),
  socialLatest: (): Promise<unknown> => ipcRenderer.invoke(ipcChannels.socialLatest),
  onSocialInbox: (listener: (message: unknown) => void): (() => void) => {
    const handler = (_event: unknown, message: unknown): void => listener(message);
    ipcRenderer.on(ipcChannels.socialInbox, handler);
    return () => ipcRenderer.removeListener(ipcChannels.socialInbox, handler);
  },

  /** Changes the local backend pushes (job progress and state); "connected" follows every (re)connection. */
  onBackendEvent: (listener: (event: unknown) => void): (() => void) => {
    const handler = (_event: unknown, event: unknown): void => listener(event);
    ipcRenderer.on(ipcChannels.backendEvent, handler);
    return () => ipcRenderer.removeListener(ipcChannels.backendEvent, handler);
  },

  /** Whether any part of the app (main window or a detached panel) is on screen right now. */
  onAppVisibility: (listener: (onScreen: boolean) => void): (() => void) => {
    const handler = (_event: unknown, onScreen: boolean): void => listener(onScreen);
    ipcRenderer.on(ipcChannels.appVisibility, handler);
    return () => ipcRenderer.removeListener(ipcChannels.appVisibility, handler);
  },

  onWindowState: (
    listener: (state: { maximized: boolean; fullscreen: boolean }) => void,
  ): (() => void) => {
    const handler = (
      _event: unknown,
      state: { maximized: boolean; fullscreen: boolean },
    ): void => listener(state);
    ipcRenderer.on(ipcChannels.windowState, handler);
    return () => ipcRenderer.removeListener(ipcChannels.windowState, handler);
  },
};

contextBridge.exposeInMainWorld("desktop", {
  ...desktopApi,
  roomParticipantId: process.argv.find(argument => argument.startsWith(roomParticipantArgument))
    ?.slice(roomParticipantArgument.length) ?? "",
});
