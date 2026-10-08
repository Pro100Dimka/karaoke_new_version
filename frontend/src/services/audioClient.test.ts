import { afterEach, describe, expect, it, vi } from "vitest";
import { audioClient, getAudioSnapshot } from "./audioClient";
import { audioRows } from "../features/settings/tabs/Audio/audioRows";

const installBridge = (
  reply: (command: string) => { status: number; text: string },
) => {
  const commands: string[] = [];
  Object.assign(window, {
    desktop: {
      audioRequest: vi.fn(async (request: { command: string }) => {
        commands.push(request.command);
        return reply(request.command);
      }),
    },
  });
  return commands;
};

describe("audioClient contract", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "desktop");
    vi.restoreAllMocks();
  });

  it.each([
    "",
    "EstimatedLatencyFrames: NaN",
    "EstimatedLatencyFrames: Infinity",
    "EstimatedLatencyFrames: -1",
    "EstimatedLatencyFrames: 0",
  ])(
    "does not turn missing or invalid latency into a measured zero: %s",
    async (latency) => {
      installBridge(() => ({
        status: 0,
        text: `RuntimeOutputSampleRate: 48000\n${latency}`,
      }));
      await expect(audioClient.runtimeConfiguration()).resolves.toMatchObject({
        estimatedLatencyMs: null,
      });
    },
  );

  it.each(["", "0", "NaN", "Infinity", "-48000"])(
    "leaves latency unknown without a valid runtime sample clock: %s",
    async (rate) => {
      installBridge(() => ({
        status: 0,
        text: `RuntimeOutputSampleRate: ${rate}\nEstimatedLatencyFrames: 1920`,
      }));
      await expect(audioClient.runtimeConfiguration()).resolves.toMatchObject({
        estimatedLatencyMs: null,
      });
    },
  );

  it("closes the song's files when playback stops, so the song can be deleted afterwards", async () => {
    const commands = installBridge(() => ({ status: 0, text: "Ok" }));
    await audioClient.stop();
    expect(commands.slice(0, 2)).toEqual(["Stop", "UnloadSong"]);
  });

  it("uses the monitoring path and the actual output clock for its estimate", async () => {
    installBridge(() => ({
      status: 0,
      text: [
        "RuntimeOutputSampleRate: 44100",
        "RequestedSampleRate: 48000",
        "MonitoringLatencyFrames: 1764",
        "EstimatedLatencyFrames: 4410",
      ].join("\n"),
    }));
    await expect(audioClient.runtimeConfiguration()).resolves.toMatchObject({
      estimatedLatencyMs: 40,
    });
  });

  it.each(["RuntimeOutputSampleRate: 0", ""])(
    "uses actual endpoint capacity and never substitutes the requested rate for runtime: %s",
    async (runtimeRate) => {
      installBridge(() => ({
        status: 0,
        text: [
          "RequestedSampleRate: 96000",
          runtimeRate,
          "RuntimeOutputPeriodFrames: 480",
          "RuntimeOutputEndpointBufferFrames: 2048",
          "RenderPaddingFrames: 120",
        ].join("\n"),
      }));
      await expect(audioClient.runtimeConfiguration()).resolves.toMatchObject({
        sampleRate: 0,
        endpointBufferFrames: 2048,
      });
    },
  );

  it("reports ready when AudioService answers Running", async () => {
    installBridge(() => ({ status: 0, text: "Running" }));
    expect(await audioClient.health()).toMatchObject({ status: "ready" });
  });

  it("reports unavailable when the transport returns a failure status", async () => {
    installBridge(() => ({
      status: -1,
      text: "AudioService unavailable: ENOENT",
    }));
    expect(await audioClient.health()).toMatchObject({ status: "unavailable" });
  });

  it("uses the AudioService suspend lifecycle while ASIO is released in the background", async () => {
    const commands = installBridge(() => ({ status: 0, text: "Ok" }));
    await audioClient.suspendSession();
    await audioClient.resumeSession();
    expect(commands).toEqual(["SuspendSession", "ResumeSession"]);
  });

  it("does not report a zero-channel capture endpoint as a usable microphone", async () => {
    installBridge(() => ({
      status: 0,
      text: "stale-input,Microphone,1,0,0\nactive-output,Speakers,1,1,2\n",
    }));
    await expect(audioClient.capabilities()).resolves.toMatchObject({
      microphone: "missing",
    });
  });

  it("issues Pause and reads a paused snapshot", async () => {
    const commands = installBridge((command) => ({
      status: 0,
      text:
        command === "GetDiagnostics"
          ? "PlaybackState: 4\nPlaybackPositionFrames: 48000\nRuntimeOutputSampleRate: 48000"
          : "Ok",
    }));
    const snapshot = await audioClient.pause();
    expect(commands).toEqual(["Pause", "GetDiagnostics"]);
    expect(snapshot).toMatchObject({ state: "paused", positionSeconds: 1 });
  });

  it.each([
    ["Prepared", ["GetDiagnostics", "StartSession", "PlayOutputTest"]],
    [
      "Prepared\nBackend: WASAPI Exclusive",
      [
        "GetDiagnostics",
        "StopSession",
        "GetDevices",
        "PrepareSession",
        "StartSession",
        "PlayOutputTest",
      ],
    ],
    [
      "Failed",
      [
        "GetDiagnostics",
        "StopSession",
        "GetDevices",
        "PrepareSession",
        "StartSession",
        "PlayOutputTest",
      ],
    ],
    ["Running", ["GetDiagnostics", "PlayOutputTest"]],
  ])(
    "brings a %s session to Running without preparing twice",
    async (sessionState, expected) => {
      const commands = installBridge((command) => ({
        status: 0,
        text:
          command === "GetDiagnostics"
            ? `SessionState: ${sessionState}`
            : command === "GetDevices"
              ? ""
              : "Ok",
      }));
      await audioClient.playTestSound();
      expect(commands).toEqual(expected);
    },
  );

  it("falls back to system audio when a saved device is absent on this computer", async () => {
    const requests: AudioBridgeRequest[] = [];
    Object.assign(window, {
      desktop: {
        audioRequest: vi.fn(async (request: AudioBridgeRequest) => {
          requests.push(request);
          return {
            status: 0,
            text:
              request.command === "GetDiagnostics"
                ? "SessionState: Idle\nBackend: WASAPI Shared"
                : request.command === "GetDevices"
                  ? "default-mic,Microphone,1,0,2\ndefault-speakers,Speakers,1,1,2"
                  : "Ok",
          };
        }),
      },
    });
    audioClient.setPreferredConfiguration({
      backend: "ASIO",
      inputDeviceId: "asio-from-another-computer",
      outputDeviceId: "asio-from-another-computer",
      sampleRate: 44100,
      periodFrames: 0,
      bufferFrames: 64,
    });

    await audioClient.playTestSound();

    expect(requests).toContainEqual({
      command: "PrepareSession",
      args: expect.objectContaining({
        backend: "wasapi-shared",
        input: undefined,
        output: undefined,
        rate: 0,
        period: 0,
      }),
    });
    audioClient.setPreferredConfiguration({
      backend: "WASAPI Shared",
      sampleRate: 0,
      periodFrames: 0,
    });
  });

  it("applies one server-owned room delay once and clears it when leaving", async () => {
    const commands: Array<{ command: string; args?: Record<string, unknown> }> =
      [];
    Object.assign(window, {
      desktop: {
        leaveRoomVoice: vi.fn(async () => undefined),
        audioRequest: vi.fn(
          async (request: {
            command: string;
            args?: Record<string, unknown>;
          }) => {
            commands.push(request);
            return { status: 0, text: "Ok" };
          },
        ),
      },
    });
    await audioClient.setRoomPlayoutDelay(84);
    await audioClient.setRoomPlayoutDelay(84);
    await audioClient.leaveVoiceSession();
    expect(
      commands
        .filter((item) => item.command === "SetRoomPlayoutDelay")
        .map((item) => item.args?.milliseconds),
    ).toEqual([84, 0]);
  });

  it("brings a session running in another mode to the chosen mode before joining a room", async () => {
    const commands: string[] = [];
    Object.assign(window, {
      desktop: {
        joinRoomVoice: vi.fn(async () => void commands.push("joinRoomVoice")),
        audioRequest: vi.fn(async (request: AudioBridgeRequest) => {
          commands.push(request.command);
          return {
            status: 0,
            text:
              request.command === "GetDiagnostics"
                ? "SessionState: Running\nBackend: WASAPI Shared"
                : "Ok",
          };
        }),
      },
    });
    audioClient.setPreferredConfiguration({
      backend: "WASAPI Exclusive",
      sampleRate: 0,
      periodFrames: 0,
      bufferFrames: 480,
    });
    await audioClient.joinVoiceSession("ROOM-2", "person-2");
    audioClient.setPreferredConfiguration({
      backend: "WASAPI Shared",
      sampleRate: 0,
      periodFrames: 0,
    });
    expect(commands.indexOf("Reconfigure")).toBeGreaterThan(-1);
    expect(commands.indexOf("Reconfigure")).toBeLessThan(
      commands.lastIndexOf("joinRoomVoice"),
    );
  });

  it("registers voice with both the room and participant identity", async () => {
    const joinRoomVoice = vi.fn(async () => undefined);
    const audioRequest = vi.fn(async (request: AudioBridgeRequest) => ({
      status: 0,
      text:
        request.command === "GetDiagnostics" ? "SessionState: Prepared" : "Ok",
    }));
    Object.assign(window, { desktop: { joinRoomVoice, audioRequest } });

    await audioClient.joinVoiceSession("ROOM-1", "person-1");

    expect(joinRoomVoice).toHaveBeenCalledWith("ROOM-1", "person-1");
    expect(audioRequest).toHaveBeenCalledWith({
      command: "StartSession",
      args: undefined,
    });
  });

  it("exposes microphone and per-participant room levels", async () => {
    installBridge((command) => ({
      status: 0,
      text:
        command === "GetDiagnostics"
          ? "InputRMS: 0.2\nRemoteLevel.guest-1: 0.7"
          : "Ok",
    }));

    await expect(audioClient.roomLevels()).resolves.toEqual({
      local: 0.2,
      remote: { "guest-1": 0.7 },
    });
  });

  it("sets the continuous server clock before enabling room voice", async () => {
    vi.spyOn(performance, "now").mockReturnValue(200);
    const commands = installBridge(() => ({
      status: 0,
      text: "SessionState: Running\nMonotonicTicks: 1000000000",
    }));
    const joinRoomVoice = vi.fn(async () => {
      expect(commands.at(-1)).toBe("SetRoomClock");
    });
    Object.assign(window.desktop!, { joinRoomVoice });
    await audioClient.joinVoiceSession("CLOCK-ROOM", "self", 1_790_000_000_000);
    expect(window.desktop?.audioRequest).toHaveBeenCalledWith({
      command: "SetRoomClock",
      args: {
        serverMicros: 1_790_000_000_200_000,
        localMicros: 1_000_000,
      },
    });
    expect(joinRoomVoice).toHaveBeenCalledOnce();
  });

  it("maps a renderer deadline onto the native monotonic clock before Play", async () => {
    vi.spyOn(performance, "now").mockReturnValue(200);
    installBridge(() => ({
      status: 0,
      text: "MonotonicTicks: 1000000000\nRuntimeOutputSampleRate: 44100",
    }));
    await audioClient.play({ startAtMilliseconds: 700, positionSeconds: 3 });
    expect(window.desktop?.audioRequest).toHaveBeenCalledWith({
      command: "Play",
      args: { startAtTicks: 1500000000, frame: 132300 },
    });
  });

  it("compares room timing with presented audio instead of the end of a queued device block", async () => {
    installBridge(() => ({
      status: 0,
      text: "PlaybackState: 3\nPlaybackPositionFrames: 48500\nPlaybackPresentationPositionFrames: 48000\nRuntimeOutputSampleRate: 48000",
    }));
    await expect(getAudioSnapshot()).resolves.toMatchObject({
      positionSeconds: 1,
    });
  });

  it("sends a shared period and an exclusive/ASIO buffer as different settings", async () => {
    const requests: AudioBridgeRequest[] = [];
    Object.assign(window, {
      desktop: {
        joinRoomVoice: vi.fn(async () => undefined),
        leaveRoomVoice: vi.fn(async () => undefined),
        audioRequest: vi.fn(async (request: AudioBridgeRequest) => {
          requests.push(request);
          return {
            status: 0,
            text:
              request.command === "GetDiagnostics"
                ? "SessionState: Running\nRuntimeOutputSampleRate: 48000\nRuntimeOutputPeriodFrames: 256"
                : "Ok",
          };
        }),
      },
    });
    await audioClient.leaveVoiceSession();
    requests.length = 0;

    await audioClient.applyConfiguration({
      backend: "WASAPI Shared",
      sampleRate: 48000,
      periodFrames: 480,
      inputPeriodFrames: 128,
      bufferFrames: 128,
    });
    expect(requests).toContainEqual({
      command: "Reconfigure",
      args: expect.objectContaining({ backend: "wasapi-shared", period: 480,
        inputPeriod: 128 }),
    });

    requests.length = 0;
    await audioClient.applyConfiguration({
      backend: "WASAPI Exclusive",
      sampleRate: 48000,
      periodFrames: 480,
      bufferFrames: 128,
    });
    expect(requests).toContainEqual({
      command: "Reconfigure",
      args: expect.objectContaining({
        backend: "wasapi-exclusive",
        period: 128,
      }),
    });
  });

  it("carries endpoint periods through IPC selection and a locked runtime into the UI", async () => {
    const requests: AudioBridgeRequest[] = [];
    const replies: Record<string, string> = {
      GetAudioCapabilities: [
        "sampleRatesHz=48000",
        "periodFrames=128,160,480",
        "defaultSampleRateHz=48000",
        "defaultPeriodFrames=480",
        "periodSelectionReason=AVAILABLE",
      ].join("\n"),
      GetDevices: "mic,Microphone,1,0,1\nphones,Headphones,1,1,2",
      GetDiagnostics: [
        "SessionState: Running",
        "Backend: WASAPI Shared",
        "RuntimeOutputSampleRate: 48000",
        "RuntimeOutputPeriodFrames: 480",
        "SelectedPeriodFrames: 128",
        "RequestedPeriodFrames: 128",
        "SharedEnginePeriodicityLocked: 1",
        "RuntimeOutputEndpointBufferFrames: 960",
      ].join("\n"),
    };
    Object.assign(window, {
      desktop: {
        audioRequest: vi.fn(async (request: AudioBridgeRequest) => {
          requests.push(request);
          return { status: 0, text: replies[request.command] ?? "Ok" };
        }),
      },
    });
    const configuration = {
      backend: "WASAPI Shared" as const,
      sampleRate: 48000,
      periodFrames: 128,
      inputDeviceId: "mic",
      outputDeviceId: "phones",
    };
    const capabilities = await audioClient.configurationCapabilities(configuration);
    const runtime = await audioClient.applyConfiguration(configuration);
    const rows = audioRows(
      ((key: string) => key) as never,
      { ...configuration, bufferFrames: 0 },
      runtime,
      [],
      true,
      () => undefined,
      capabilities,
    );
    const period = rows.find((row) => "tag" in row && row.tag === "periodFrames") as
      { options: readonly { value: number }[]; hint: string };
    for (const command of ["GetAudioCapabilities", "Reconfigure"])
      expect(requests).toContainEqual({
        command,
        args: expect.objectContaining({ input: "mic", output: "phones", rate: 48000, period: 128 }),
      });
    expect(period.options.map((option) => option.value)).toEqual([128, 160, 480]);
    expect(period.hint).toContain("audioPeriodSelected:");
    expect(period.hint).toContain("audioPeriodRequested:");
    expect(period.hint).toContain("audioPeriodActual:");
    expect(period.hint).toContain("audioPeriodReason: ENGINE_PERIODICITY_LOCKED");
  });

  it("lets AudioService negotiate channels and preserves a requested small ASIO buffer", async () => {
    const requests: AudioBridgeRequest[] = [];
    Object.assign(window, {
      desktop: {
        audioRequest: vi.fn(async (request: AudioBridgeRequest) => {
          requests.push(request);
          return {
            status: 0,
            text:
              request.command === "GetDiagnostics"
                ? "SessionState: Running\nRuntimeOutputSampleRate: 44100\nRuntimeOutputPeriodFrames: 8"
                : request.command === "GetDevices"
                  ? "selected-asio,ASIO Driver,3,0,2\nselected-asio,ASIO Driver,3,1,2"
                  : "Ok",
          };
        }),
      },
    });

    await audioClient.applyConfiguration({
      backend: "ASIO",
      inputDeviceId: "selected-asio",
      outputDeviceId: "selected-asio",
      sampleRate: 44100,
      periodFrames: 8,
      bufferFrames: 8,
    });

    expect(requests).toContainEqual({
      command: "Reconfigure",
      args: expect.objectContaining({
        backend: "asio",
        inChannels: 0,
        outChannels: 0,
        period: 8,
      }),
    });
  });

  it("preserves the driver's preferred period independently of enumeration order", async () => {
    installBridge(() => ({
      status: 0,
      text: "sampleRatesHz=44100\nperiodFrames=104,8,56\ndefaultSampleRateHz=44100\ndefaultPeriodFrames=56",
    }));
    await expect(
      audioClient.configurationCapabilities({
        backend: "ASIO",
        sampleRate: 0,
        periodFrames: 0,
      }),
    ).resolves.toMatchObject({
      defaultPeriodFrames: 56,
      periodFrames: [8, 56, 104],
    });
  });

  it("keeps the driver origin for a linear buffer range", async () => {
    installBridge(() => ({
      status: 0,
      text: "sampleRatesHz=44100\nminPeriodFrames=8\nmaxPeriodFrames=104\nfundamentalPeriodFrames=16\ndefaultSampleRateHz=44100\ndefaultPeriodFrames=56",
    }));
    await expect(
      audioClient.configurationCapabilities({
        backend: "ASIO",
        sampleRate: 0,
        periodFrames: 0,
      }),
    ).resolves.toMatchObject({
      defaultPeriodFrames: 56,
      periodFrames: [8, 24, 40, 56, 72, 88, 104],
    });
  });

  it("reports room voice timing from live AudioService jitter and buffer diagnostics", async () => {
    installBridge((command) => ({
      status: 0,
      text:
        command === "GetDiagnostics"
          ? [
              "RuntimeOutputSampleRate: 48000",
              "EstimatedLatencyFrames: 480",
              "NetworkRoundTripMs: 34",
              "NetworkPacketsSent: 1234",
              "NetworkPacketsReceived: 1200",
              "NetworkRelayEchoes: 31",
              "NetworkTransportRunning: 1",
              "NetworkSendEnabled: 1",
              "RemoteJitterMs.friend: 4.5",
              "RemoteTargetDelayFrames.friend: 1440",
              "RemoteRelayFirstPackets.friend: 12",
              "RemoteDirectFirstPackets.friend: 4000",
              "RemoteLateAudioCuts.friend: 2",
              "RemoteTimelineExcluded.friend: 0",
              "RoomCompensationFrames: 1920",
              "RoomRequestedDelayFrames: 2400",
              "RoomReturnRequirementFrames: 192",
              "RoomArrivalRequirementFrames: 480",
              "RoomPlayoutDelayFrames: 7680",
              "RoomFollowFrames: 1920",
            ].join("\n")
          : "Ok",
    }));

    await expect(audioClient.roomTiming()).resolves.toEqual({
      roundTripMs: 34,
      deviceLatencyMs: 10,
      packetsSent: 1234,
      packetsReceived: 1200,
      relayEchoes: 31,
      networkTransportRunning: true,
      networkSendEnabled: true,
      remotes: {
        friend: {
          jitterMs: 4.5,
          targetDelayMs: 30,
          relayPackets: 12,
          directPackets: 4000,
          lateCuts: 2,
          excluded: false,
        },
      },
      estimatedVoiceLatencyMs: 27,
      requestedVoiceDelayMs: 50,
      returnRequirementMs: 4,
      arrivalRequirementMs: 10,
      roomPlayoutDelayMs: 160,
      voiceDelayMs: 40,
      followMs: 0,
      deviceStarvedFrames: 0,
    });
  });

  it("does not invent a device sample rate when AudioService has not reported one", async () => {
    installBridge((command) => ({
      status: 0,
      text:
        command === "GetDiagnostics"
          ? "EstimatedLatencyFrames: 480\nRemoteJitterMs.friend: 5\nRemoteTargetDelayFrames.friend: 1440"
          : "Ok",
    }));

    await expect(audioClient.roomTiming()).resolves.toEqual({
      roundTripMs: 0,
      deviceLatencyMs: 0,
      packetsSent: 0,
      packetsReceived: 0,
      relayEchoes: 0,
      networkTransportRunning: false,
      networkSendEnabled: false,
      remotes: {
        friend: {
          jitterMs: 5,
          targetDelayMs: 0,
          relayPackets: 0,
          directPackets: 0,
          lateCuts: 0,
        },
      },
      estimatedVoiceLatencyMs: 0,
      voiceDelayMs: 0,
      followMs: 0,
      deviceStarvedFrames: 0,
    });
  });

  it.each(["join", "leave"] as const)(
    "preserves the selected Exclusive device when rooms %s",
    async (action) => {
      const requests: AudioBridgeRequest[] = [];
      Object.assign(window, {
        desktop: {
          joinRoomVoice: vi.fn(async () => undefined),
          leaveRoomVoice: vi.fn(async () => undefined),
          audioRequest: vi.fn(async (request: AudioBridgeRequest) => {
            requests.push(request);
            return {
              status: 0,
              text:
                request.command === "GetDiagnostics"
                  ? "SessionState: Running"
                  : "Ok",
            };
          }),
        },
      });
      audioClient.setPreferredConfiguration({
        backend: "WASAPI Shared",
        sampleRate: 44100,
        periodFrames: 441,
      });
      await audioClient.leaveVoiceSession();
      audioClient.setPreferredConfiguration({
        backend: "WASAPI Exclusive",
        sampleRate: 44100,
        periodFrames: 441,
      });
      if (action === "leave")
        await audioClient.joinVoiceSession("ROOM-1", "self");
      requests.length = 0;
      if (action === "join")
        await audioClient.joinVoiceSession("ROOM-1", "self");
      else await audioClient.leaveVoiceSession();
      expect(
        requests.filter((request) => request.command === "Reconfigure"),
      ).toEqual([]);
    },
  );

  it("opens the requested Exclusive backend while preserving room voice and peer gains", async () => {
    const requests: AudioBridgeRequest[] = [];
    const joinRoomVoice = vi.fn(async () => undefined);
    const leaveRoomVoice = vi.fn(async () => undefined);
    const setRoomVoiceParticipantGain = vi.fn(async () => undefined);
    Object.assign(window, {
      desktop: {
        joinRoomVoice,
        leaveRoomVoice,
        setRoomVoiceParticipantGain,
        audioRequest: vi.fn(async (request: AudioBridgeRequest) => {
          requests.push(request);
          return {
            status: 0,
            text:
              request.command === "GetDiagnostics"
                ? "SessionState: Running\nBackend: WASAPI Shared\nRuntimeOutputSampleRate: 48000\nRuntimeOutputPeriodFrames: 256"
                : "Ok",
          };
        }),
      },
    });
    audioClient.setPreferredConfiguration({
      backend: "WASAPI Shared",
      sampleRate: 48000,
      periodFrames: 256,
    });
    await audioClient.leaveVoiceSession();
    requests.length = 0;
    joinRoomVoice.mockClear();
    setRoomVoiceParticipantGain.mockClear();

    await audioClient.joinVoiceSession("ROOM-1", "self");
    await audioClient.addRemoteParticipant("friend");
    await audioClient.setParticipantVolume("friend", 0.42);
    expect(setRoomVoiceParticipantGain).toHaveBeenCalledWith("friend", 0.42);
    expect(requests).not.toContainEqual({
      command: "SetRemoteGain",
      args: { participantId: "friend", value: 0.42 },
    });
    requests.length = 0;
    joinRoomVoice.mockClear();

    await audioClient.applyConfiguration({
      backend: "WASAPI Exclusive",
      sampleRate: 48000,
      periodFrames: 256,
    });

    expect(joinRoomVoice).toHaveBeenCalledWith("ROOM-1", "self");
    expect(requests).toEqual(
      expect.arrayContaining([
        {
          command: "Reconfigure",
          args: expect.objectContaining({ backend: "wasapi-exclusive" }),
        },
        {
          command: "AddRemoteParticipant",
          args: { participantId: "__room_server_mix__" },
        },
        {
          command: "SetRemoteGain",
          args: { participantId: "__room_server_mix__", value: 1 },
        },
      ]),
    );
    expect(setRoomVoiceParticipantGain).toHaveBeenCalledWith("friend", 0.42);
    requests.length = 0;
    await audioClient.leaveVoiceSession();
    expect(
      requests.filter((request) => request.command === "Reconfigure"),
    ).toEqual([]);
  });

  it("restores room voice after a rejected driver switch so the previous backend keeps working", async () => {
    const joinRoomVoice = vi.fn(async () => undefined);
    let rejectReconfigure = false;
    let sessionState = "Running";
    const requests: AudioBridgeRequest[] = [];
    Object.assign(window, {
      desktop: {
        joinRoomVoice,
        leaveRoomVoice: vi.fn(async () => undefined),
        audioRequest: vi.fn(async (request: AudioBridgeRequest) => {
          requests.push(request);
          if (
            request.command === "Reconfigure" &&
            rejectReconfigure &&
            request.args?.backend === "asio"
          ) {
            sessionState = "Failed";
            return { status: 5, text: "exclusive render initialize failed" };
          }
          if (request.command === "Reconfigure") sessionState = "Prepared";
          if (request.command === "StartSession") sessionState = "Running";
          return {
            status: 0,
            text:
              request.command === "GetDiagnostics"
                ? `SessionState: ${sessionState}\nBackend: WASAPI Shared\nRuntimeOutputSampleRate: 48000\nRuntimeOutputPeriodFrames: 256`
                : "Ok",
          };
        }),
      },
    });
    audioClient.setPreferredConfiguration({
      backend: "WASAPI Shared",
      sampleRate: 48000,
      periodFrames: 256,
    });
    await audioClient.leaveVoiceSession();
    await audioClient.joinVoiceSession("ROOM-1", "self");
    joinRoomVoice.mockClear();
    rejectReconfigure = true;

    await expect(
      audioClient.applyConfiguration({
        backend: "ASIO",
        sampleRate: 48000,
        periodFrames: 256,
      }),
    ).rejects.toBeDefined();

    expect(joinRoomVoice).toHaveBeenCalledWith("ROOM-1", "self");
    expect(requests.some((request) => request.command === "StartSession")).toBe(
      true,
    );
  });

  it.each([
    [
      "sample rate",
      {
        backend: "WASAPI Shared" as const,
        sampleRate: 44100,
        periodFrames: 256,
      },
    ],
    [
      "buffer size",
      {
        backend: "WASAPI Shared" as const,
        sampleRate: 48000,
        periodFrames: 512,
      },
    ],
  ])(
    "restarts and re-registers room voice after changing %s",
    async (_label, configuration) => {
      const joinRoomVoice = vi.fn(async () => undefined);
      let sessionState = "Running";
      const requests: AudioBridgeRequest[] = [];
      Object.assign(window, {
        desktop: {
          joinRoomVoice,
          leaveRoomVoice: vi.fn(async () => undefined),
          audioRequest: vi.fn(async (request: AudioBridgeRequest) => {
            requests.push(request);
            if (request.command === "Reconfigure") sessionState = "Prepared";
            if (request.command === "StartSession") sessionState = "Running";
            return {
              status: 0,
              text:
                request.command === "GetDiagnostics"
                  ? `SessionState: ${sessionState}\nBackend: WASAPI Shared\nRuntimeOutputSampleRate: ${configuration.sampleRate}\nRuntimeOutputPeriodFrames: ${configuration.periodFrames}`
                  : "Ok",
            };
          }),
        },
      });
      audioClient.setPreferredConfiguration({
        backend: "WASAPI Shared",
        sampleRate: 48000,
        periodFrames: 256,
      });
      await audioClient.leaveVoiceSession();
      await audioClient.joinVoiceSession("ROOM-1", "self");
      joinRoomVoice.mockClear();
      requests.length = 0;

      await audioClient.applyConfiguration(configuration);

      expect(requests).toContainEqual({
        command: "StartSession",
        args: undefined,
      });
      expect(joinRoomVoice).toHaveBeenCalledWith("ROOM-1", "self");
    },
  );

  it("restores the playing song and mix after changing room sample rate", async () => {
    let sessionState = "Running";
    let playbackFrames = 96_000;
    let runtimeRate = 48_000;
    const requests: AudioBridgeRequest[] = [];
    Object.assign(window, {
      desktop: {
        joinRoomVoice: vi.fn(async () => undefined),
        leaveRoomVoice: vi.fn(async () => undefined),
        resolveProjectArtifacts: vi.fn(async () => ({
          instrumental: "instrumental.wav",
          vocals: "vocals.wav",
          melody: "melody.wav",
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
            text:
              request.command === "GetDiagnostics"
                ? `SessionState: ${sessionState}\nPlaybackState: 3\nPlaybackPositionFrames: ${playbackFrames}\nRuntimeOutputSampleRate: ${runtimeRate}\nRuntimeOutputPeriodFrames: 256`
                : "Ok",
          };
        }),
      },
    });
    const song = {
      id: "song",
      activeRevision: 2,
      durationSeconds: 180,
    } as never;
    audioClient.setPreferredConfiguration({
      backend: "WASAPI Shared",
      sampleRate: 48000,
      periodFrames: 256,
    });
    await audioClient.leaveVoiceSession();
    await audioClient.joinVoiceSession("ROOM-1", "self");
    await audioClient.prepareSong(song);
    await audioClient.setMixer("music", 0.7);
    await audioClient.play();
    requests.length = 0;

    await audioClient.applyConfiguration({
      backend: "WASAPI Shared",
      sampleRate: 44100,
      periodFrames: 512,
    });

    expect(requests).toEqual(
      expect.arrayContaining([
        {
          command: "LoadSong",
          args: expect.objectContaining({ instrumental: "instrumental.wav" }),
        },
        {
          command: "SetGain",
          args: { target: "music", value: expect.closeTo(0.7 ** 3, 6) },
        },
        { command: "Seek", args: { frame: 88_200 } },
        { command: "Play", args: undefined },
      ]),
    );
    await audioClient.leaveVoiceSession();
  });

  it("restores current DSP values before monitoring becomes audible", async () => {
    const requests: AudioBridgeRequest[] = [];
    Object.assign(window, {
      desktop: {
        audioRequest: vi.fn(async (request: AudioBridgeRequest) => {
          requests.push(request);
          return {
            status: 0,
            text:
              request.command === "GetDiagnostics"
                ? "SessionState: Running"
                : "Ok",
          };
        }),
      },
    });
    await audioClient.setDspParameter("reverb.mix", 0.42);
    await audioClient.setDspEnabled(true);
    requests.length = 0;

    await audioClient.setMonitoring(true);

    expect(requests.slice(0, 3)).toEqual([
      { command: "SetDspParameter", args: { name: "reverb.mix", value: 0.42 } },
      { command: "SetDspEnabled", args: { enabled: true } },
      { command: "SetMonitoring", args: { enabled: true } },
    ]);
  });

  it("blocks ASIO4ALL monitoring before sending any audible output to an unverified route", async () => {
    const requests: AudioBridgeRequest[] = [];
    Object.assign(window, { desktop: { audioRequest: vi.fn(async (request: AudioBridgeRequest) => {
      requests.push(request);
      return { status: 0, text: request.command === "GetDevices"
        ? "asio4all,ASIO4ALL v2,3,0,0\nasio4all,ASIO4ALL v2,3,1,0\nspeakers,Speaker (Realtek),1,1,2"
        : request.command === "GetDiagnostics"
          ? "SessionState: Running\nBackend: ASIO\nMonitoringEnabled: 0"
          : "Ok" };
    }) } });
    const { audioState } = await import("./audioSession");
    const previous = audioState.active;
    audioState.active = { backend: "ASIO", inputDeviceId: "asio4all",
      outputDeviceId: "asio4all", sampleRate: 48_000, periodFrames: 0 };
    try {
      await expect(audioClient.setMonitoring(true)).rejects.toThrow(/ASIO4ALL/);
      expect(requests).not.toContainEqual({ command: "SetMonitoring", args: { enabled: true } });
      expect(requests).not.toContainEqual(expect.objectContaining({ command: "SetDspEnabled" }));
    } finally {
      audioState.active = previous;
    }
  });
});
