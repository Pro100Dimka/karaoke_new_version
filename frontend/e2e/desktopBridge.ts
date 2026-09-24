/**
 * Installs a scripted stand-in for the Electron preload bridge so the renderer can be exercised in a plain browser.
 * It replays the same wire shapes the real Python Backend and AudioService return.
 */
export const installDesktopBridge = (): void => {
  const song = {
    songId: "song-1",
    title: "Люди",
    artist: "Бумбокс",
    album: null,
    duration: 30,
    language: "Ukrainian",
    status: "Ready",
    activeRevision: 1,
    projectFormatVersion: 2,
    coverState: "Fallback",
    createdAt: "2026-01-01T00:00:00Z"
  };
  const editor = {
    songId: "song-1",
    revision: 1,
    document: {
      title: "Люди",
      artist: "Бумбокс",
      duration: 30,
      bpm: null,
      key: null,
      lyrics: "Люди залишаються людьми",
      words: [
        { text: "Люди", start: 0, end: 1, notes: [{ note: 60, start: 0, end: 1 }] },
        { text: "залишаються", start: 1, end: 2, notes: [{ note: 62, start: 1, end: 2 }] }
      ]
    }
  };

  const python = (request: { method: string; path: string }) => {
    const path = request.path.split("?")[0] ?? "";
    const reply = (body: unknown) => ({ status: 200, ok: true, body });
    if (path === "/health/ready") return reply({ ok: true, state: "Ready" });
    if (path === "/version") return reply({ backendVersion: "1.0.0", apiVersion: 1 });
    if (path === "/songs") return reply({ items: [song], nextCursor: null });
    if (path === "/jobs") return reply({ items: [], limit: 200, offset: 0 });
    if (path === "/songs/song-1") return reply(song);
    if (path === "/songs/song-1/project/compatibility") return reply({ compatibility: "Current" });
    if (path === "/songs/song-1/editor") return reply(editor);
    if (path.startsWith("/recordings")) return reply({ items: [], total: 0, limit: 200, offset: 0 });
    return { status: 404, ok: false, body: { code: "NotFound", message: path } };
  };

  const audioState = { playing: false, frames: 0 };
  const audio = (request: { command: string }) => {
    const ok = (text = "Ok") => ({ status: 0, text });
    switch (request.command) {
      case "GetServiceState":
        return ok("Running");
      case "GetDevices":
        return ok("in-1,Mic,1,0,1\nout-1,Speakers,1,1,2");
      case "GetDiagnostics":
        return ok(
          `SessionState: Running\nPlaybackState: ${audioState.playing ? 3 : 2}\nPlaybackPositionFrames: ${audioState.frames}\nRuntimeOutputSampleRate: 48000`
        );
      case "Play":
        audioState.playing = true;
        return ok();
      case "Pause":
      case "Stop":
        audioState.playing = false;
        return ok();
      default:
        return ok();
    }
  };

  const noop = async () => undefined;
  Object.assign(window, {
    desktop: {
      minimize: noop,
      toggleMaximize: async () => false,
      close: noop,
      isMaximized: async () => false,
      isFullscreen: async () => false,
      toggleFullscreen: async () => false,
      pickAudioFile: async () => null,
      pickImageFile: async () => null,
      sceneVideoUrl: async () => null,
      setAppIcon: noop,
      appReady: noop,
      statFile: async () => ({ name: "a.mp3", extension: "mp3", sizeBytes: 1 }),
      pathForFile: () => "",
      revealInExplorer: noop,
      openExternal: noop,
      openMicrophonePrivacy: noop,
      saveTextFile: async () => true,
      copyText: noop,
      confirmClose: noop,
      onCloseRequested: () => () => undefined,
      onWindowState: () => () => undefined,
      pythonRequest: async (request: { method: string; path: string }) => python(request),
      // No e2e scenario exercises the online room yet; unhandled paths fall through to the same 404 as python().
      roomRequest: async (request: { method: string; path: string }) => python(request),
      joinRoomVoice: noop,
      leaveRoomVoice: noop,
      keyboardLightingCapabilities: async () => ({ available: false, deviceCount: 0 }),
      setKeyboardLighting: noop,
      uploadRoomProject: noop,
      downloadRoomProject: async () => "D:/e2e/song.advoice.zip",
      cancelRoomProjectTransfer: noop,
      onRoomProjectTransferProgress: () => () => undefined,
      audioRequest: async (request: { command: string }) => audio(request),
      waveformPeaks: async () => Array.from({ length: 64 }, (_, index) => 0.2 + (index % 7) / 10),
      recordingPeaks: async () => Array.from({ length: 64 }, (_, index) => 0.2 + (index % 5) / 10),
      resolveProjectArtifacts: async () => ({ instrumental: "instrumental.wav" }),
      revealProject: noop,
      inspectWave: async () => ({ sampleRate: 48000, channels: 1, durationSeconds: 1 })
    }
  });
};
