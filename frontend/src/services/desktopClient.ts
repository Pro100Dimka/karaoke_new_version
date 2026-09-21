import type { DesktopClient } from "../contracts/clients";

const unavailable = async (): Promise<void> => undefined;
export const desktopClient: DesktopClient = window.desktop ?? {
  minimize: unavailable,
  async toggleMaximize() { return false; },
  close: unavailable,
  async isMaximized() { return false; },
  async pickAudioFile() { return null; },
  revealInExplorer: unavailable,
  openExternal: unavailable,
  copyText: unavailable,
  async pythonRequest() { throw new Error("Desktop bridge is unavailable"); },
  async audioRequest() { throw new Error("Desktop bridge is unavailable"); },
  async waveformPeaks() { return []; },
  async resolveProjectArtifacts() { throw new Error("Desktop bridge is unavailable"); },
  revealProject: unavailable,
  async inspectWave() { throw new Error("Desktop bridge is unavailable"); },
  async setAppIcon() { return undefined; },
  appReady: unavailable,
  async sceneVideoUrl() { return null; },
  async pickImageFile() { return null; },
  async statFile() { throw new Error("Desktop bridge is unavailable"); },
  pathForFile() { return ""; },
  async toggleFullscreen() { return false; },
  async isFullscreen() { return false; },
  async saveTextFile() { return false; },
  openMicrophonePrivacy: unavailable,
  confirmClose: unavailable,
  onCloseRequested() { return () => undefined; },
  onWindowState() { return () => undefined; }
};
