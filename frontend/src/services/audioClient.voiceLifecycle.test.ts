import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => Reflect.deleteProperty(window, "desktop"));

it("restores the server mix slot after every room voice session recreation", async () => {
  const requests: AudioBridgeRequest[] = [];
  Object.assign(window, { desktop: {
    joinRoomVoice: vi.fn(async () => undefined),
    leaveRoomVoice: vi.fn(async () => undefined),
    audioRequest: vi.fn(async (request: AudioBridgeRequest) => {
      requests.push(request);
      return { status: 0, text: request.command === "GetDiagnostics" ? "SessionState: Running" : "Ok" };
    })
  } });
  const { audioClient } = await import("./audioClient");
  const expectServerMixRestored = () => expect(requests).toContainEqual({
    command: "AddRemoteParticipant",
    args: { participantId: "__room_server_mix__" }
  });

  await audioClient.joinVoiceSession("room", "self");
  expectServerMixRestored();

  requests.length = 0;
  await audioClient.joinVoiceSession("room", "self");
  expectServerMixRestored();

  requests.length = 0;
  await audioClient.reconnectVoiceSession();
  expectServerMixRestored();

  requests.length = 0;
  await audioClient.applyConfiguration({
    backend: "WASAPI Shared",
    sampleRate: 48_000,
    periodFrames: 256
  });
  expectServerMixRestored();

  requests.length = 0;
  await audioClient.leaveVoiceSession();
  await audioClient.joinVoiceSession("room", "self");
  expectServerMixRestored();
});

it("restores personal participant gain after reconnect without recreating a nonexistent client slot", async () => {
  const requests: AudioBridgeRequest[] = [];
  const joinRoomVoice = vi.fn(async () => undefined);
  const setRoomVoiceParticipantGain = vi.fn(async () => undefined);
  Object.assign(window, { desktop: {
    joinRoomVoice,
    setRoomVoiceParticipantGain,
    audioRequest: vi.fn(async (request: AudioBridgeRequest) => {
      requests.push(request);
      return { status: 0, text: request.command === "GetDiagnostics" ? "SessionState: Running" : "Ok" };
    })
  } });
  const { audioClient } = await import("./audioClient");
  await audioClient.joinVoiceSession("room", "self");
  await audioClient.setParticipantVolume("friend", 0.42);
  requests.length = 0;
  setRoomVoiceParticipantGain.mockClear();
  await audioClient.reconnectVoiceSession();
  expect(setRoomVoiceParticipantGain).toHaveBeenCalledWith("friend", 0.42);
  expect(requests.filter(request => request.command === "AddRemoteParticipant")).toEqual([{
    command: "AddRemoteParticipant",
    args: { participantId: "__room_server_mix__" }
  }]);
});

it("does not carry a muted personal mix into a newly joined room", async () => {
  const setRoomVoiceParticipantGain = vi.fn(async () => undefined);
  Object.assign(window, { desktop: {
    joinRoomVoice: vi.fn(async () => undefined),
    leaveRoomVoice: vi.fn(async () => undefined),
    setRoomVoiceParticipantGain,
    audioRequest: vi.fn(async (request: AudioBridgeRequest) => ({
      status: 0,
      text: request.command === "GetDiagnostics" ? "SessionState: Running" : "Ok"
    }))
  } });
  const { audioClient } = await import("./audioClient");

  await audioClient.joinVoiceSession("old-room", "self");
  await audioClient.setParticipantVolume("host", 0);
  await audioClient.setParticipantMuted("host", true);
  await audioClient.leaveVoiceSession();
  setRoomVoiceParticipantGain.mockClear();

  await audioClient.joinVoiceSession("new-room", "self");

  expect(setRoomVoiceParticipantGain).not.toHaveBeenCalledWith("host", 0);
  expect(audioClient.participantMuted("host")).toBe(false);
});

it("keeps the selected ASIO backend across a temporary WASAPI fallback and restores it on room join", async () => {
  const requests: AudioBridgeRequest[] = [];
  let devicesAvailable = false;
  let backend = "WASAPI Shared";
  let sessionState = "Idle";
  Object.assign(window, { desktop: {
    joinRoomVoice: vi.fn(async () => undefined),
    audioRequest: vi.fn(async (request: AudioBridgeRequest) => {
      requests.push(request);
      if (request.command === "PrepareSession" || request.command === "Reconfigure") {
        backend = request.args?.backend === "asio" ? "ASIO" : "WASAPI Shared";
        sessionState = "Prepared";
      }
      if (request.command === "StartSession") sessionState = "Running";
      return {
        status: 0,
        text: request.command === "GetDiagnostics"
          ? `SessionState: ${sessionState}\nBackend: ${backend}\nRuntimeOutputSampleRate: 48000`
          : request.command === "GetDevices"
            ? devicesAvailable
              ? "asio-driver,ASIO Driver,3,0,2\nasio-driver,ASIO Driver,3,1,2"
              : "default-mic,Microphone,1,0,2\ndefault-output,Speakers,1,1,2"
            : "Ok",
      };
    }),
  } });
  const { audioClient } = await import("./audioClient");
  audioClient.setPreferredConfiguration({
    backend: "ASIO", inputDeviceId: "asio-driver", outputDeviceId: "asio-driver",
    sampleRate: 48_000, periodFrames: 0, bufferFrames: 128,
  });

  // The driver is briefly unavailable during ordinary startup, so audio continues on Shared.
  await audioClient.playTestSound();
  expect(requests).toContainEqual(expect.objectContaining({
    command: "PrepareSession", args: expect.objectContaining({ backend: "wasapi-shared" }),
  }));

  devicesAvailable = true;
  requests.length = 0;
  await audioClient.joinVoiceSession("room", "self");

  expect(requests).toContainEqual(expect.objectContaining({
    command: "Reconfigure", args: expect.objectContaining({
      backend: "asio", input: "asio-driver", output: "asio-driver", period: 128,
    }),
  }));
});
