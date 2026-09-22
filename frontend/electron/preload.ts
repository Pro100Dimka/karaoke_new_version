import { contextBridge, ipcRenderer, webUtils } from "electron";
import { ipcChannels } from "./ipcChannels";

const desktopApi = {
  minimize: (): Promise<void> => ipcRenderer.invoke(ipcChannels.minimize),

  toggleMaximize: (): Promise<boolean> =>
    ipcRenderer.invoke(ipcChannels.toggleMaximize),

  close: (): Promise<void> => ipcRenderer.invoke(ipcChannels.close),

  isMaximized: (): Promise<boolean> =>
    ipcRenderer.invoke(ipcChannels.isMaximized),

  pickAudioFile: (): Promise<string | null> =>
    ipcRenderer.invoke(ipcChannels.pickAudioFile),

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

  uploadRoomProject: (request: unknown): Promise<unknown> =>
    ipcRenderer.invoke(ipcChannels.uploadRoomProject, request),

  downloadRoomProject: (request: unknown): Promise<unknown> =>
    ipcRenderer.invoke(ipcChannels.downloadRoomProject, request),

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

  confirmClose: (): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.confirmClose),

  onCloseRequested: (listener: () => void): (() => void) => {
    const handler = (): void => listener();
    ipcRenderer.on(ipcChannels.closeRequested, handler);
    return () => ipcRenderer.removeListener(ipcChannels.closeRequested, handler);
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

contextBridge.exposeInMainWorld("desktop", desktopApi);
