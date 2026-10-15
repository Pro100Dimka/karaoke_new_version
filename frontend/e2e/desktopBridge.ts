/**
 * Installs a scripted stand-in for the Electron preload bridge so the renderer can be exercised in a plain browser.
 * It replays the same wire shapes the real Python Backend and AudioService return.
 */
export const installDesktopBridge = (): void => {
  // Specs set these before installing the bridge to opt into richer settings scenarios.
  const scenario = window as unknown as {
    e2eAudioSettings?: boolean;
    e2eSettingsHistory?: boolean;
  };
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
    artworkUrl:
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1200' height='800'%3E%3Cdefs%3E%3ClinearGradient id='g'%3E%3Cstop stop-color='%23eee'/%3E%3Cstop offset='1' stop-color='%23800'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='1200' height='800' fill='url(%23g)'/%3E%3C/svg%3E",
    createdAt: "2026-01-01T00:00:00Z",
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
        {
          text: "Люди",
          start: 0,
          end: 1,
          notes: [{ note: 60, start: 0, end: 1 }],
        },
        {
          text: "залишаються",
          start: 1,
          end: 2,
          notes: [{ note: 62, start: 1, end: 2 }],
        },
      ],
    },
  };

  // A spec may ask for more songs before this runs (window.e2eExtraSongs = ["Title", …]): copies of
  // the first one under ids song-2, song-3, ….
  const extraTitles =
    (window as unknown as { e2eExtraSongs?: string[] }).e2eExtraSongs ?? [];
  const songs = [
    song,
    ...extraTitles.map((title, index) => ({ ...song, songId: `song-${index + 2}`, title })),
  ];

  const python = (request: { method: string; path: string }) => {
    const path = request.path.split("?")[0] ?? "";
    const reply = (body: unknown) => ({ status: 200, ok: true, body });
    if (path === "/health/ready") return reply({ ok: true, state: "Ready" });
    if (path === "/version")
      return reply({ backendVersion: "1.0.0", apiVersion: 1 });
    if (path === "/songs") return reply({ items: songs, nextCursor: null });
    if (path === "/history" && scenario.e2eSettingsHistory) {
      const query = new URLSearchParams(request.path.split("?")[1]);
      const types = query.getAll("types");
      const items = [
        "RecordingRegistered",
        "AnalysisCompleted",
        "RecordingRegistered",
        "ProcessingStarted",
        "ProcessingSucceeded",
        "ProcessingFailed",
      ]
        .map((eventType, index) => ({
          eventId: `history-${index + 1}`,
          eventType,
          createdAt: `2026-10-${String(15 - index).padStart(2, "0")}T16:30:00Z`,
          entityId: "song-1",
          songId: "song-1",
          details: { source: "local" },
        }))
        .filter((event) => types.length === 0 || types.includes(event.eventType));
      const offset = Number(query.get("offset")) || 0;
      const limit = Number(query.get("limit")) || 50;
      return reply({ items: items.slice(offset, offset + limit), total: items.length });
    }
    if (path === "/jobs") return reply({ items: [], limit: 200, offset: 0 });
    if (path === "/models")
      return reply([
        {
          modelId: "whisper-base",
          purpose: "ASR",
          version: "1",
          size: 145000000,
          state: "Ready",
          selected: true,
        },
        {
          modelId: "mms-fn",
          purpose: "Alignment",
          version: "1",
          size: 85000000,
          state: "Ready",
          selected: true,
        },
        {
          modelId: "htdemucs",
          purpose: "Separation",
          version: "1",
          size: 92000000,
          state: "Ready",
          selected: true,
        },
      ]);
    if (path === "/diagnostics")
      return reply({
        backend: { state: "Ready", database: true },
        ai: { cuda_available: true, gpu_name: "Test GPU" },
        versions: { dbSchema: 1, projectFormat: 2 },
        storage: {
          usage: {
            songs: 1,
            models: 1,
            cache: 0,
            recordings: 0,
            temp: 0,
            free: 50_000_000_000,
          },
        },
        recovery: { interruptedTransactions: 0 },
      });
    if (path === "/settings")
      return reply({
        processingBackend: "Local",
        kaggleUrl: "https://example.gradio.live",
        kaggleConfigured: true,
      });
    if (path === "/settings/environment")
      return reply([
        {
          key: "KAGGLE_API_TOKEN",
          group: "kaggle",
          kind: "secret",
          value: "",
          configured: true,
          state: "unverified",
          message: "Сохранено",
        },
        {
          key: "AD_VOICE_AUDD_TOKEN",
          group: "recognition",
          kind: "secret",
          value: "",
          configured: true,
          state: "valid",
          message: "Проверено",
        },
        {
          key: "AD_VOICE_YOUTUBE_API_KEY",
          group: "recognition",
          kind: "secret",
          value: "",
          configured: false,
          state: "empty",
          message: "Не настроено",
        },
        {
          key: "AD_VOICE_ROOM_SERVER_HOST",
          group: "room",
          kind: "text",
          value: "rooms.example.com",
          configured: true,
          state: "valid",
          message: "Проверено",
        },
        {
          key: "AD_VOICE_ROOM_SERVER_PORT",
          group: "room",
          kind: "port",
          value: "8081",
          configured: true,
          state: "valid",
          message: "Проверено",
        },
        {
          key: "AD_VOICE_ROOM_SERVER_RELAY_PORT",
          group: "room",
          kind: "port",
          value: "40000",
          configured: true,
          state: "valid",
          message: "Проверено",
        },
        {
          key: "AD_VOICE_ROOM_SERVER_SSH_KEY",
          group: "deployment",
          kind: "file",
          value: "D:/secrets/room_server",
          configured: true,
          state: "valid",
          message: "Проверено",
        },
        {
          key: "AD_VOICE_ROOM_SERVER_KNOWN_HOSTS",
          group: "deployment",
          kind: "file",
          value: "D:/secrets/known_hosts",
          configured: true,
          state: "valid",
          message: "Проверено",
        },
        {
          key: "AD_VOICE_ROOM_SERVER_SSH_USER",
          group: "deployment",
          kind: "text",
          value: "ubuntu",
          configured: true,
          state: "valid",
          message: "Проверено",
        },
      ]);
    if (path === "/settings/kaggle/verify")
      return reply({ state: "valid", message: "Kaggle notebook доступен" });
    if (path.startsWith("/settings/environment/") && path.endsWith("/verify")) {
      const key = path.split("/")[3] ?? "";
      const definitions: Record<
        string,
        { group: string; kind: string; value: string }
      > = {
        AD_VOICE_AUDD_TOKEN: {
          group: "recognition",
          kind: "secret",
          value: "",
        },
        AD_VOICE_ROOM_SERVER_HOST: {
          group: "room",
          kind: "text",
          value: "rooms.example.com",
        },
        AD_VOICE_ROOM_SERVER_PORT: {
          group: "room",
          kind: "port",
          value: "8081",
        },
        AD_VOICE_ROOM_SERVER_RELAY_PORT: {
          group: "room",
          kind: "port",
          value: "40000",
        },
        AD_VOICE_ROOM_SERVER_SSH_KEY: {
          group: "deployment",
          kind: "file",
          value: "D:/secrets/room_server",
        },
        AD_VOICE_ROOM_SERVER_KNOWN_HOSTS: {
          group: "deployment",
          kind: "file",
          value: "D:/secrets/known_hosts",
        },
        AD_VOICE_ROOM_SERVER_SSH_USER: {
          group: "deployment",
          kind: "text",
          value: "ubuntu",
        },
      };
      return reply({
        key,
        ...definitions[key],
        configured: true,
        state: "valid",
        message: "Проверено",
      });
    }
    const songPath = /^\/songs\/([^/]+)(\/project\/compatibility|\/editor)?$/.exec(path);
    const known = songPath && songs.find((item) => item.songId === songPath[1]);
    if (known && !songPath[2]) return reply(known);
    if (known && songPath[2] === "/editor")
      return reply({ ...editor, songId: known.songId, document: { ...editor.document, title: known.title } });
    if (known) return reply({ compatibility: "Current" });
    if (path.startsWith("/recordings"))
      return reply({ items: [], total: 0, limit: 200, offset: 0 });
    return {
      status: 404,
      ok: false,
      body: { code: "NotFound", message: path },
    };
  };

  const audioState = {
    playing: false,
    frames: 0,
    session: "Running",
    backend: "wasapi-shared",
    input: "",
    output: "",
    rate: 48000,
    period: 480,
    inputPeriod: 480,
    requestedRate: 0,
    requestedPeriod: 0,
    requestedInputPeriod: 0,
    lowLatencyInput: false,
    monitoring: false,
  };
  const audio = (request: AudioBridgeRequest) => {
    const ok = (text = "Ok") => ({ status: 0, text });
    const args = request.args ?? {};
    const shared = (args.backend ?? audioState.backend) === "wasapi-shared";
    switch (request.command) {
      case "GetServiceState":
        return ok("Running");
      case "GetDevices":
        return ok(scenario.e2eAudioSettings ? [
          "in-1,Микрофон (Realtek(R) Audio — встроенная звуковая карта),1,0,2",
          "out-1,Динамики / Наушники (Realtek(R) Audio — встроенная звуковая карта),1,1,2",
          "audient-asio,Audient USB Audio ASIO,3,0,2",
          "audient-asio,Audient USB Audio ASIO,3,1,2",
          "asio4all,ASIO4ALL v2,3,0,2",
          "asio4all,ASIO4ALL v2,3,1,2",
        ].join("\n") : "in-1,Mic,1,0,1\nout-1,Speakers,1,1,2");
      case "GetAudioCapabilities": {
        if (!scenario.e2eAudioSettings) return ok();
        return ok(Object.entries({
          sampleRatesHz: shared ? "48000" : "44100,48000,96000",
          defaultSampleRateHz: 48000,
          periodFrames: shared ? "48,96,144,192,240,480" : "32,64,128,256,512,1024",
          defaultPeriodFrames: shared ? 480 : 128,
          minPeriodFrames: shared ? 48 : 32,
          maxPeriodFrames: shared ? 480 : 1024,
          fundamentalPeriodFrames: shared ? 48 : 1,
          ...(shared && {
            inputPeriodFrames: "48,96,144,192,240,480",
            inputDefaultPeriodFrames: 480,
            inputMinPeriodFrames: 48,
            inputMaxPeriodFrames: 480,
            inputFundamentalPeriodFrames: 48,
            inputSampleRateHz: 48000,
          }),
        }).map(([key, value]) => `${key}=${value}`).join("\n"));
      }
      case "CreateSession":
      case "PrepareSession":
      case "Reconfigure":
        if (scenario.e2eAudioSettings) {
          Object.assign(audioState, {
            session: "Prepared",
            backend: String(args.backend ?? "wasapi-shared"),
            input: String(args.input ?? ""),
            output: String(args.output ?? ""),
            rate: Number(args.rate) || 48000,
            period: Number(args.period) || (shared ? 480 : 128),
            inputPeriod: Number(args.inputPeriod) || Number(args.period) || (shared ? 480 : 128),
            requestedRate: Number(args.rate) || 0,
            requestedPeriod: Number(args.period) || 0,
            requestedInputPeriod: Number(args.inputPeriod) || 0,
            lowLatencyInput: args.lowLatencyInput === 1,
            monitoring: false,
          });
        }
        return ok();
      case "StartSession":
      case "ResumeSession":
        audioState.session = "Running";
        return ok();
      case "StopSession":
      case "SuspendSession":
        audioState.session = "Idle";
        return ok();
      case "SetMonitoring":
        audioState.monitoring = args.enabled === true;
        return ok();
      case "GetClock":
        return ok(scenario.e2eAudioSettings ? `MonotonicTicks: ${Math.round(performance.now() * 1e6)}` : "Ok");
      case "GetDiagnostics": {
        if (scenario.e2eAudioSettings) {
          const periodMs = audioState.period * 1000 / audioState.rate;
          const latencyMs = periodMs * (audioState.backend === "wasapi-shared" ? 2 : 3) + 3;
          const backends: Record<string, string> = {
            "wasapi-shared": "WASAPI Shared",
            "wasapi-exclusive": "WASAPI Exclusive",
            asio: "ASIO",
          };
          return ok(Object.entries({
            MonotonicTicks: Math.round(performance.now() * 1e6),
            SessionState: audioState.session,
            Backend: backends[audioState.backend],
            ActiveInputDeviceId: audioState.input || (audioState.backend === "asio" ? "audient-asio" : "system-default"),
            ActiveOutputDeviceId: audioState.output || (audioState.backend === "asio" ? "audient-asio" : "system-default"),
            PlaybackState: audioState.playing ? 3 : 2,
            PlaybackPositionFrames: audioState.frames,
            RequestedSampleRate: audioState.requestedRate,
            SelectedSampleRate: audioState.rate,
            RuntimeInputSampleRate: audioState.rate,
            RuntimeOutputSampleRate: audioState.rate,
            RuntimeInputPeriodFrames: audioState.inputPeriod,
            RuntimeOutputPeriodFrames: audioState.period,
            RequestedPeriodFrames: audioState.requestedPeriod,
            SelectedPeriodFrames: audioState.period,
            RequestedInputPeriodFrames: audioState.requestedInputPeriod,
            SelectedInputPeriodFrames: audioState.inputPeriod,
            PeriodSelectionFallback: "NONE",
            PeriodMismatchReason: "NONE",
            InputPeriodMismatchReason: "NONE",
            RuntimeOutputEndpointBufferFrames: audioState.period * 2,
            LowLatencyMicrophoneRequested: Number(audioState.lowLatencyInput),
            LowLatencyMicrophoneActive: Number(audioState.lowLatencyInput),
            LowLatencyMicrophoneFallback: "NONE",
            InputUnavailableReason: "NONE",
            InputRMS: 0.14,
            MonitoringEnabled: Number(audioState.monitoring),
            "AsioInputChannelName.0": "Microphone 1",
            "AsioInputChannelRms.0": 0.14,
            LocalObservedMonitoringMs: latencyMs,
            LocalObservedLatencyState: "AVAILABLE",
            LocalCaptureEstimateSource: "DRIVER_REPORTED",
            LocalCaptureDeviceMs: periodMs,
            LocalRenderQueueMs: periodMs,
            LocalEndpointOutputMs: 1,
            LocalAudioServiceInternalMs: 1.5,
            LocalResamplerDspMs: 0.5,
            ReportedInputLatencyHns: Math.round(periodMs * 10000),
            AcousticCalibrationOrigin: "NONE",
            AcousticCalibrationValid: 0,
          }).map(([key, value]) => `${key}: ${value}`).join("\n"));
        }
        return ok(
          `SessionState: Running\nPlaybackState: ${audioState.playing ? 3 : 2}\nPlaybackPositionFrames: ${audioState.frames}\nRuntimeOutputSampleRate: 48000`,
        );
      }
      // What a test puts on `window.e2eAudio` is what AudioService "hears": the output bands
      // (radio, songs) and the microphone's RMS.
      case "GetSpectrum": {
        const bands = (window as unknown as { e2eAudio?: { bands?: number[] } }).e2eAudio?.bands ?? [];
        return ok(`bands=${bands.join(",")};backingBands=${bands.join(",")}`);
      }
      case "GetInputLevel": {
        const rms = (window as unknown as { e2eAudio?: { rms?: number } }).e2eAudio?.rms ?? (scenario.e2eAudioSettings ? 0.14 : 0);
        return ok(`peak=${rms};rms=${rms};present=${rms > 0 ? 1 : 0};clipping=0`);
      }
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
      keepDisplayAwake: async () => false,
      reportShellStatus: async (status: unknown) => {
        (window as unknown as { e2eShellStatus?: unknown }).e2eShellStatus = status;
      },
      onShellCommand: (listener: (command: unknown) => void) => {
        (window as unknown as { e2eShellCommand?: (command: unknown) => void }).e2eShellCommand = listener;
        return () => undefined;
      },
      notify: noop,
      installUpdate: async () => false,
      close: noop,
      isMaximized: async () => false,
      isFullscreen: async () => false,
      toggleFullscreen: async () => false,
      pickAudioFile: async () => null,
      pickAudioFiles: async () => [],
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
      pythonRequest: async (request: { method: string; path: string }) =>
        python(request),
      // No e2e scenario exercises the online room yet; unhandled paths fall through to the same 404 as python().
      roomRequest: async (request: { method: string; path: string }) =>
        python(request),
      socialLatest: async () => ({
        type: "inbox",
        me: {
          accountId: "e2e-user",
          displayName: "BBB",
          friendCode: "E2E-CODE",
          transferCode: "",
          avatarVersion: 0,
        },
        friends: [],
        friendRequests: [],
        outgoingRequests: [],
        invites: [],
        notices: [],
      }),
      onSocialInbox: () => () => undefined,
      socialPresence: noop,
      joinRoomVoice: noop,
      setRoomVoiceParticipantGain: noop,
      leaveRoomVoice: noop,
      keyboardLightingCapabilities: async () => ({
        available: false,
        deviceCount: 0,
      }),
      setKeyboardLighting: noop,
      uploadRoomProject: noop,
      downloadRoomProject: async () => "D:/e2e/song.advoice.zip",
      cancelRoomProjectTransfer: noop,
      onRoomProjectTransferProgress: () => () => undefined,
      audioRequest: async (request: AudioBridgeRequest) => audio(request),
      waveformPeaks: async () =>
        Array.from({ length: 64 }, (_, index) => 0.2 + (index % 7) / 10),
      recordingPeaks: async () =>
        Array.from({ length: 64 }, (_, index) => 0.2 + (index % 5) / 10),
      resolveProjectArtifacts: async () => ({
        instrumental: "instrumental.wav",
      }),
      revealProject: noop,
      inspectWave: async () => ({
        sampleRate: 48000,
        channels: 1,
        durationSeconds: 1,
      }),
    },
  });
};
