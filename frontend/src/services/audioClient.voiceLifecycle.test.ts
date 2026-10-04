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
