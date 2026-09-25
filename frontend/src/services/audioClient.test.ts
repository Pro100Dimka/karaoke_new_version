import { afterEach, describe, expect, it, vi } from "vitest";
import { audioClient, getAudioSnapshot } from "./audioClient";

const installBridge = (reply: (command: string) => { status: number; text: string }) => {
  const commands: string[] = [];
  Object.assign(window, {
    desktop: {
      audioRequest: vi.fn(async (request: { command: string }) => {
        commands.push(request.command);
        return reply(request.command);
      })
    }
  });
  return commands;
};

describe("audioClient contract", () => {
  afterEach(() => { Reflect.deleteProperty(window, "desktop"); vi.restoreAllMocks(); });

  it.each(["RuntimeOutputSampleRate: 0", ""])("uses actual endpoint capacity and never substitutes the requested rate for runtime: %s", async runtimeRate => {
    installBridge(() => ({ status: 0, text: [
      "RequestedSampleRate: 96000", runtimeRate, "RuntimeOutputPeriodFrames: 480",
      "RuntimeOutputEndpointBufferFrames: 2048", "RenderPaddingFrames: 120",
    ].join("\n") }));
    await expect(audioClient.runtimeConfiguration()).resolves.toMatchObject({
      sampleRate: 0, endpointBufferFrames: 2048,
    });
  });

  it("reports ready when AudioService answers Running", async () => {
    installBridge(() => ({ status: 0, text: "Running" }));
    expect(await audioClient.health()).toMatchObject({ status: "ready" });
  });

  it("reports unavailable when the transport returns a failure status", async () => {
    installBridge(() => ({ status: -1, text: "AudioService unavailable: ENOENT" }));
    expect(await audioClient.health()).toMatchObject({ status: "unavailable" });
  });

  it("issues Pause and reads a paused snapshot", async () => {
    const commands = installBridge(command => ({
      status: 0,
      text: command === "GetDiagnostics" ? "PlaybackState: 4\nPlaybackPositionFrames: 48000\nRuntimeOutputSampleRate: 48000" : "Ok"
    }));
    const snapshot = await audioClient.pause();
    expect(commands).toEqual(["Pause", "GetDiagnostics"]);
    expect(snapshot).toMatchObject({ state: "paused", positionSeconds: 1 });
  });

  it.each([
    ["Prepared", ["GetDiagnostics", "StartSession", "PlayOutputTest"]],
    ["Failed", ["GetDiagnostics", "StopSession", "GetDevices", "PrepareSession", "StartSession", "PlayOutputTest"]],
    ["Running", ["GetDiagnostics", "PlayOutputTest"]]
  ])("brings a %s session to Running without preparing twice", async (sessionState, expected) => {
    const commands = installBridge(command => ({
      status: 0,
      text: command === "GetDiagnostics" ? `SessionState: ${sessionState}` : command === "GetDevices" ? "" : "Ok"
    }));
    await audioClient.playTestSound();
    expect(commands).toEqual(expected);
  });

  it("registers voice with both the room and participant identity", async () => {
    const joinRoomVoice = vi.fn(async () => undefined);
    const audioRequest = vi.fn(async (request: AudioBridgeRequest) => ({
      status: 0,
      text: request.command === "GetDiagnostics" ? "SessionState: Prepared" : "Ok"
    }));
    Object.assign(window, { desktop: { joinRoomVoice, audioRequest } });

    await audioClient.joinVoiceSession("ROOM-1", "person-1");

    expect(joinRoomVoice).toHaveBeenCalledWith("ROOM-1", "person-1");
    expect(audioRequest).toHaveBeenCalledWith({ command: "StartSession", args: undefined });
  });

  it("exposes microphone and per-participant room levels", async () => {
    installBridge(command => ({
      status: 0,
      text: command === "GetDiagnostics"
        ? "InputRMS: 0.2\nRemoteLevel.guest-1: 0.7"
        : "Ok"
    }));

    await expect(audioClient.roomLevels()).resolves.toEqual({
      local: 0.2,
      remote: { "guest-1": 0.7 }
    });
  });

  it("sets the continuous server clock before enabling room voice", async () => {
    vi.spyOn(performance, "now").mockReturnValue(200);
    const commands = installBridge(() => ({ status: 0, text: "SessionState: Running\nMonotonicTicks: 1000000000" }));
    const joinRoomVoice = vi.fn(async () => { expect(commands.at(-1)).toBe("SetRoomClock"); });
    Object.assign(window.desktop!, { joinRoomVoice });
    await audioClient.joinVoiceSession("CLOCK-ROOM", "self", 1_790_000_000_000);
    expect(window.desktop?.audioRequest).toHaveBeenCalledWith({ command: "SetRoomClock", args: {
      serverMicros: 1_790_000_000_200_000, localMicros: 1_000_000,
    } });
    expect(joinRoomVoice).toHaveBeenCalledOnce();
  });

  it("maps a renderer deadline onto the native monotonic clock before Play", async () => {
    vi.spyOn(performance, "now").mockReturnValue(200);
    installBridge(() => ({ status: 0, text: "MonotonicTicks: 1000000000\nRuntimeOutputSampleRate: 44100" }));
    await audioClient.play({ startAtMilliseconds: 700, positionSeconds: 3 });
    expect(window.desktop?.audioRequest).toHaveBeenCalledWith({ command: "Play", args: { startAtTicks: 1500000000, frame: 132300 } });
  });

  it("compares room timing with presented audio instead of the end of a queued device block", async () => {
    installBridge(() => ({ status: 0, text: "PlaybackState: 3\nPlaybackPositionFrames: 48500\nPlaybackPresentationPositionFrames: 48000\nRuntimeOutputSampleRate: 48000" }));
    await expect(getAudioSnapshot()).resolves.toMatchObject({ positionSeconds: 1 });
  });

  it("loads sample-rate and buffer options from the selected device", async () => {
    const commands = installBridge(command => ({
      status: 0,
      text: command === "GetAudioCapabilities"
        ? "sampleRatesHz=44100,48000\nperiodFrames=128,256,512\ndefaultSampleRateHz=44100\ndefaultPeriodFrames=256"
        : "Ok"
    }));

    await expect(audioClient.configurationCapabilities({
      backend: "WASAPI Shared",
      sampleRate: 0,
      periodFrames: 0
    })).resolves.toEqual({
      sampleRates: [44100, 48000],
      periodFrames: [128, 256, 512],
      defaultSampleRate: 44100,
      defaultPeriodFrames: 256
    });
    expect(commands).toContain("GetAudioCapabilities");
  });

  it("preserves ASIO buffer sizes and the default reported by the driver", async () => {
    installBridge(command => ({
      status: 0,
      text: command === "GetAudioCapabilities"
        ? "sampleRatesHz=44100\nperiodFrames=8,16,32,64,128\ndefaultSampleRateHz=44100\ndefaultPeriodFrames=8"
        : "Ok"
    }));

    await expect(audioClient.configurationCapabilities({
      backend: "ASIO",
      sampleRate: 44100,
      periodFrames: 8,
      bufferFrames: 8
    })).resolves.toMatchObject({
      periodFrames: [8, 16, 32, 64, 128],
      defaultPeriodFrames: 8
    });
  });

  it("sends a shared period and an exclusive/ASIO buffer as different settings", async () => {
    const requests: AudioBridgeRequest[] = [];
    Object.assign(window, { desktop: {
      joinRoomVoice: vi.fn(async () => undefined),
      leaveRoomVoice: vi.fn(async () => undefined),
      audioRequest: vi.fn(async (request: AudioBridgeRequest) => {
        requests.push(request);
        return {
          status: 0,
          text: request.command === "GetDiagnostics"
            ? "SessionState: Running\nRuntimeOutputSampleRate: 48000\nRuntimeOutputPeriodFrames: 256"
            : "Ok"
        };
      })
    } });
    await audioClient.leaveVoiceSession();
    requests.length = 0;

    await audioClient.applyConfiguration({
      backend: "WASAPI Shared", sampleRate: 48000, periodFrames: 480, bufferFrames: 128
    });
    expect(requests).toContainEqual({
      command: "Reconfigure",
      args: expect.objectContaining({ backend: "wasapi-shared", period: 480 })
    });

    requests.length = 0;
    await audioClient.applyConfiguration({
      backend: "WASAPI Exclusive", sampleRate: 48000, periodFrames: 480, bufferFrames: 128
    });
    expect(requests).toContainEqual({
      command: "Reconfigure",
      args: expect.objectContaining({ backend: "wasapi-exclusive", period: 128 })
    });
  });

  it("lets AudioService negotiate channels and preserves a requested small ASIO buffer", async () => {
    const requests: AudioBridgeRequest[] = [];
    Object.assign(window, { desktop: {
      audioRequest: vi.fn(async (request: AudioBridgeRequest) => {
        requests.push(request);
        return {
          status: 0,
          text: request.command === "GetDiagnostics"
            ? "SessionState: Running\nRuntimeOutputSampleRate: 44100\nRuntimeOutputPeriodFrames: 8"
            : "Ok"
        };
      })
    } });

    await audioClient.applyConfiguration({
      backend: "ASIO",
      inputDeviceId: "selected-asio",
      outputDeviceId: "selected-asio",
      sampleRate: 44100,
      periodFrames: 8,
      bufferFrames: 8
    });

    expect(requests).toContainEqual({
      command: "Reconfigure",
      args: expect.objectContaining({ backend: "asio", inChannels: 0, outChannels: 0, period: 8 })
    });
  });

  it("preserves the driver's preferred period independently of enumeration order", async () => {
    installBridge(() => ({ status: 0, text:
      "sampleRatesHz=44100\nperiodFrames=104,8,56\ndefaultSampleRateHz=44100\ndefaultPeriodFrames=56" }));
    await expect(audioClient.configurationCapabilities({ backend: "ASIO", sampleRate: 0, periodFrames: 0 }))
      .resolves.toMatchObject({ defaultPeriodFrames: 56, periodFrames: [8, 56, 104] });
  });

  it("keeps the driver origin for a linear buffer range", async () => {
    installBridge(() => ({ status: 0, text:
      "sampleRatesHz=44100\nminPeriodFrames=8\nmaxPeriodFrames=104\nfundamentalPeriodFrames=16\ndefaultSampleRateHz=44100\ndefaultPeriodFrames=56" }));
    await expect(audioClient.configurationCapabilities({ backend: "ASIO", sampleRate: 0, periodFrames: 0 }))
      .resolves.toMatchObject({ defaultPeriodFrames: 56, periodFrames: [8, 24, 40, 56, 72, 88, 104] });
  });

  it("reports room voice timing from live AudioService jitter and buffer diagnostics", async () => {
    installBridge(command => ({
      status: 0,
      text: command === "GetDiagnostics"
        ? [
            "RuntimeOutputSampleRate: 48000",
            "EstimatedLatencyFrames: 480",
            "NetworkRoundTripMs: 34",
            "RemoteJitterMs.friend: 4.5",
            "RemoteTargetDelayFrames.friend: 1440"
          ].join("\n")
        : "Ok"
    }));

    await expect(audioClient.roomTiming()).resolves.toEqual({
      roundTripMs: 34,
      deviceLatencyMs: 10,
      remotes: { friend: { jitterMs: 4.5, targetDelayMs: 30 } },
      estimatedVoiceLatencyMs: 27
    });
  });

  it("does not invent a device sample rate when AudioService has not reported one", async () => {
    installBridge(command => ({
      status: 0,
      text: command === "GetDiagnostics"
        ? "EstimatedLatencyFrames: 480\nRemoteJitterMs.friend: 5\nRemoteTargetDelayFrames.friend: 1440"
        : "Ok"
    }));

    await expect(audioClient.roomTiming()).resolves.toEqual({
      roundTripMs: 0,
      deviceLatencyMs: 0,
      remotes: { friend: { jitterMs: 5, targetDelayMs: 0 } },
      estimatedVoiceLatencyMs: 0
    });
  });

  it.each(["join", "leave"] as const)("preserves the selected Exclusive device when rooms %s", async action => {
    const requests: AudioBridgeRequest[] = [];
    Object.assign(window, { desktop: {
      joinRoomVoice: vi.fn(async () => undefined), leaveRoomVoice: vi.fn(async () => undefined),
      audioRequest: vi.fn(async (request: AudioBridgeRequest) => {
        requests.push(request);
        return { status: 0, text: request.command === "GetDiagnostics" ? "SessionState: Running" : "Ok" };
      }),
    } });
    audioClient.setPreferredConfiguration({ backend: "WASAPI Shared", sampleRate: 44100, periodFrames: 441 });
    await audioClient.leaveVoiceSession();
    audioClient.setPreferredConfiguration({ backend: "WASAPI Exclusive", sampleRate: 44100, periodFrames: 441 });
    if (action === "leave") await audioClient.joinVoiceSession("ROOM-1", "self");
    requests.length = 0;
    if (action === "join") await audioClient.joinVoiceSession("ROOM-1", "self");
    else await audioClient.leaveVoiceSession();
    expect(requests.filter(request => request.command === "Reconfigure")).toEqual([]);
  });

  it("opens the requested Exclusive backend while preserving room voice and peer gains", async () => {
    const requests: AudioBridgeRequest[] = [];
    const joinRoomVoice = vi.fn(async () => undefined);
    const leaveRoomVoice = vi.fn(async () => undefined);
    Object.assign(window, { desktop: {
      joinRoomVoice,
      leaveRoomVoice,
      audioRequest: vi.fn(async (request: AudioBridgeRequest) => {
        requests.push(request);
        return {
          status: 0,
          text: request.command === "GetDiagnostics"
            ? "SessionState: Running\nBackend: WASAPI Shared\nRuntimeOutputSampleRate: 48000\nRuntimeOutputPeriodFrames: 256"
            : "Ok"
        };
      })
    } });
    audioClient.setPreferredConfiguration({ backend: "WASAPI Shared", sampleRate: 48000, periodFrames: 256 });
    await audioClient.leaveVoiceSession();
    requests.length = 0;
    joinRoomVoice.mockClear();

    await audioClient.joinVoiceSession("ROOM-1", "self");
    await audioClient.addRemoteParticipant("friend");
    await audioClient.setParticipantVolume("friend", 0.42);
    requests.length = 0;
    joinRoomVoice.mockClear();

    await audioClient.applyConfiguration({ backend: "WASAPI Exclusive", sampleRate: 48000, periodFrames: 256 });

    expect(joinRoomVoice).toHaveBeenCalledWith("ROOM-1", "self");
    expect(requests).toEqual(expect.arrayContaining([
      { command: "Reconfigure", args: expect.objectContaining({ backend: "wasapi-exclusive" }) },
      { command: "AddRemoteParticipant", args: { participantId: "friend" } },
      { command: "SetRemoteGain", args: { participantId: "friend", value: 0.42 } }
    ]));
    requests.length = 0;
    await audioClient.leaveVoiceSession();
    expect(requests.filter(request => request.command === "Reconfigure")).toEqual([]);
  });

  it("restores room voice after a rejected driver switch so the previous backend keeps working", async () => {
    const joinRoomVoice = vi.fn(async () => undefined);
    let rejectReconfigure = false;
    let sessionState = "Running";
    const requests: AudioBridgeRequest[] = [];
    Object.assign(window, { desktop: {
      joinRoomVoice,
      leaveRoomVoice: vi.fn(async () => undefined),
      audioRequest: vi.fn(async (request: AudioBridgeRequest) => {
        requests.push(request);
        if (request.command === "Reconfigure" && rejectReconfigure && request.args?.backend === "asio") {
          sessionState = "Failed";
          return { status: 5, text: "exclusive render initialize failed" };
        }
        if (request.command === "Reconfigure") sessionState = "Prepared";
        if (request.command === "StartSession") sessionState = "Running";
        return {
          status: 0,
          text: request.command === "GetDiagnostics"
            ? `SessionState: ${sessionState}\nBackend: WASAPI Shared\nRuntimeOutputSampleRate: 48000\nRuntimeOutputPeriodFrames: 256`
            : "Ok"
        };
      })
    } });
    audioClient.setPreferredConfiguration({ backend: "WASAPI Shared", sampleRate: 48000, periodFrames: 256 });
    await audioClient.leaveVoiceSession();
    await audioClient.joinVoiceSession("ROOM-1", "self");
    joinRoomVoice.mockClear();
    rejectReconfigure = true;

    await expect(audioClient.applyConfiguration({
      backend: "ASIO",
      sampleRate: 48000,
      periodFrames: 256
    })).rejects.toBeDefined();

    expect(joinRoomVoice).toHaveBeenCalledWith("ROOM-1", "self");
    expect(requests.some(request => request.command === "StartSession")).toBe(true);
  });

  it.each([
    ["sample rate", { backend: "WASAPI Shared" as const, sampleRate: 44100, periodFrames: 256 }],
    ["buffer size", { backend: "WASAPI Shared" as const, sampleRate: 48000, periodFrames: 512 }]
  ])("restarts and re-registers room voice after changing %s", async (_label, configuration) => {
    const joinRoomVoice = vi.fn(async () => undefined);
    let sessionState = "Running";
    const requests: AudioBridgeRequest[] = [];
    Object.assign(window, { desktop: {
      joinRoomVoice,
      leaveRoomVoice: vi.fn(async () => undefined),
      audioRequest: vi.fn(async (request: AudioBridgeRequest) => {
        requests.push(request);
        if (request.command === "Reconfigure") sessionState = "Prepared";
        if (request.command === "StartSession") sessionState = "Running";
        return {
          status: 0,
          text: request.command === "GetDiagnostics"
            ? `SessionState: ${sessionState}\nBackend: WASAPI Shared\nRuntimeOutputSampleRate: ${configuration.sampleRate}\nRuntimeOutputPeriodFrames: ${configuration.periodFrames}`
            : "Ok"
        };
      })
    } });
    audioClient.setPreferredConfiguration({ backend: "WASAPI Shared", sampleRate: 48000, periodFrames: 256 });
    await audioClient.leaveVoiceSession();
    await audioClient.joinVoiceSession("ROOM-1", "self");
    joinRoomVoice.mockClear();
    requests.length = 0;

    await audioClient.applyConfiguration(configuration);

    expect(requests).toContainEqual({ command: "StartSession", args: undefined });
    expect(joinRoomVoice).toHaveBeenCalledWith("ROOM-1", "self");
  });

  it("restores the playing song and mix after changing room sample rate", async () => {
    let sessionState = "Running";
    let playbackFrames = 96_000;
    let runtimeRate = 48_000;
    const requests: AudioBridgeRequest[] = [];
    Object.assign(window, { desktop: {
      joinRoomVoice: vi.fn(async () => undefined),
      leaveRoomVoice: vi.fn(async () => undefined),
      resolveProjectArtifacts: vi.fn(async () => ({
        instrumental: "instrumental.wav", vocals: "vocals.wav", melody: "melody.wav"
      })),
      audioRequest: vi.fn(async (request: AudioBridgeRequest) => {
        requests.push(request);
        if (request.command === "Reconfigure") {
          sessionState = "Prepared";
          playbackFrames = 0;
          runtimeRate = Number(request.args?.rate) || runtimeRate;
        }
        if (request.command === "StartSession") sessionState = "Running";
        return {
          status: 0,
          text: request.command === "GetDiagnostics"
            ? `SessionState: ${sessionState}\nPlaybackState: 3\nPlaybackPositionFrames: ${playbackFrames}\nRuntimeOutputSampleRate: ${runtimeRate}\nRuntimeOutputPeriodFrames: 256`
            : "Ok"
        };
      })
    } });
    const song = { id: "song", activeRevision: 2, durationSeconds: 180 } as never;
    audioClient.setPreferredConfiguration({ backend: "WASAPI Shared", sampleRate: 48000, periodFrames: 256 });
    await audioClient.leaveVoiceSession();
    await audioClient.joinVoiceSession("ROOM-1", "self");
    await audioClient.prepareSong(song);
    await audioClient.setMixer("music", 0.7);
    await audioClient.play();
    requests.length = 0;

    await audioClient.applyConfiguration({ backend: "WASAPI Shared", sampleRate: 44100, periodFrames: 512 });

    expect(requests).toEqual(expect.arrayContaining([
      { command: "LoadSong", args: expect.objectContaining({ instrumental: "instrumental.wav" }) },
      { command: "SetGain", args: { target: "music", value: 0.7 } },
      { command: "Seek", args: { frame: 88_200 } },
      { command: "Play", args: undefined }
    ]));
    await audioClient.leaveVoiceSession();
  });

  it("restores current DSP values before monitoring becomes audible", async () => {
    const requests: AudioBridgeRequest[] = [];
    Object.assign(window, { desktop: { audioRequest: vi.fn(async (request: AudioBridgeRequest) => {
      requests.push(request);
      return { status: 0, text: request.command === "GetDiagnostics" ? "SessionState: Running" : "Ok" };
    }) } });
    await audioClient.setDspParameter("reverb.mix", 0.42);
    await audioClient.setDspEnabled(true);
    requests.length = 0;

    await audioClient.setMonitoring(true);

    expect(requests.slice(0, 3)).toEqual([
      { command: "SetDspParameter", args: { name: "reverb.mix", value: 0.42 } },
      { command: "SetDspEnabled", args: { enabled: true } },
      { command: "SetMonitoring", args: { enabled: true } }
    ]);
  });
});
