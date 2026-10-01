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
    artworkUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1200' height='800'%3E%3Cdefs%3E%3ClinearGradient id='g'%3E%3Cstop stop-color='%23eee'/%3E%3Cstop offset='1' stop-color='%23800'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='1200' height='800' fill='url(%23g)'/%3E%3C/svg%3E",
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
    if (path === "/models") return reply([
      { modelId: "whisper-base", purpose: "ASR", version: "1", size: 145000000, state: "Ready", selected: true },
      { modelId: "mms-fn", purpose: "Alignment", version: "1", size: 85000000, state: "Ready", selected: true },
      { modelId: "htdemucs", purpose: "Separation", version: "1", size: 92000000, state: "Ready", selected: true },
    ]);
    if (path === "/diagnostics") return reply({
      backend: { state: "Ready", database: true },
      ai: { cuda_available: true, gpu_name: "Test GPU" },
      versions: { dbSchema: 1, projectFormat: 2 },
      storage: { usage: { songs: 1, models: 1, cache: 0, recordings: 0, temp: 0, free: 1000000 } },
      recovery: { interruptedTransactions: 0 },
    });
    if (path === "/settings") return reply({
      processingBackend: "Local", kaggleUrl: "https://example.gradio.live", kaggleToken: "kaggle-demo-token", kaggleConfigured: true,
    });
    if (path === "/settings/environment") return reply([
      { key: "KAGGLE_API_TOKEN", group: "kaggle", kind: "secret", value: "KGAT_DEMO_not_a_real_access_token", configured: true, state: "unverified", message: "Сохранено" },
      { key: "AD_VOICE_AUDD_TOKEN", group: "recognition", kind: "secret", value: "AUDD_DEMO_not_a_real_access_token", configured: true, state: "valid", message: "Проверено" },
      { key: "AD_VOICE_YOUTUBE_API_KEY", group: "recognition", kind: "secret", value: "", configured: false, state: "empty", message: "Не настроено" },
      { key: "AD_VOICE_ROOM_SERVER_HOST", group: "room", kind: "text", value: "rooms.example.com", configured: true, state: "valid", message: "Проверено" },
      { key: "AD_VOICE_ROOM_SERVER_PORT", group: "room", kind: "port", value: "8081", configured: true, state: "valid", message: "Проверено" },
      { key: "AD_VOICE_ROOM_SERVER_RELAY_PORT", group: "room", kind: "port", value: "40000", configured: true, state: "valid", message: "Проверено" },
      { key: "AD_VOICE_ROOM_SERVER_SSH_KEY", group: "deployment", kind: "file", value: "D:/secrets/room_server", configured: true, state: "valid", message: "Проверено" },
      { key: "AD_VOICE_ROOM_SERVER_KNOWN_HOSTS", group: "deployment", kind: "file", value: "D:/secrets/known_hosts", configured: true, state: "valid", message: "Проверено" },
      { key: "AD_VOICE_ROOM_SERVER_SSH_USER", group: "deployment", kind: "text", value: "ubuntu", configured: true, state: "valid", message: "Проверено" },
    ]);
    if (path === "/settings/kaggle/verify") return reply({ state: "valid", message: "Kaggle notebook доступен" });
    if (path.startsWith("/settings/environment/") && path.endsWith("/verify")) {
      const key = path.split("/")[3] ?? "";
      const definitions: Record<string, { group: string; kind: string; value: string }> = {
        AD_VOICE_AUDD_TOKEN: { group: "recognition", kind: "secret", value: "AUDD_DEMO_not_a_real_access_token" },
        AD_VOICE_ROOM_SERVER_HOST: { group: "room", kind: "text", value: "rooms.example.com" },
        AD_VOICE_ROOM_SERVER_PORT: { group: "room", kind: "port", value: "8081" },
        AD_VOICE_ROOM_SERVER_RELAY_PORT: { group: "room", kind: "port", value: "40000" },
        AD_VOICE_ROOM_SERVER_SSH_KEY: { group: "deployment", kind: "file", value: "D:/secrets/room_server" },
        AD_VOICE_ROOM_SERVER_KNOWN_HOSTS: { group: "deployment", kind: "file", value: "D:/secrets/known_hosts" },
        AD_VOICE_ROOM_SERVER_SSH_USER: { group: "deployment", kind: "text", value: "ubuntu" },
      };
      return reply({ key, ...definitions[key], configured: true, state: "valid", message: "Проверено" });
    }
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
      getStorageRoot: async () => "D:/AD Voice/data",
      pickStorageFolder: async () => null,
      setStorageRoot: noop,
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
      socialLatest: async () => ({
        type: "inbox",
        me: { accountId: "e2e-user", displayName: "BBB", friendCode: "E2E-CODE", transferCode: "", avatarVersion: 0 },
        friends: [], friendRequests: [], outgoingRequests: [], invites: [], notices: [],
      }),
      onSocialInbox: () => () => undefined,
      socialPresence: noop,
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
