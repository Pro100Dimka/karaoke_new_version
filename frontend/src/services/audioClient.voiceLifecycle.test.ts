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

it("restores participant routes and effects after reconnect but isolates a different room", async () => {
  const requests: AudioBridgeRequest[] = [];
  const joinRoomVoice = vi.fn(async () => undefined);
  Object.assign(window, { desktop: {
    joinRoomVoice,
    audioRequest: vi.fn(async (request: AudioBridgeRequest) => {
      requests.push(request);
      return { status: 0, text: request.command === "GetDiagnostics" ? "SessionState: Running" : "Ok" };
    })
  } });
  const { audioClient } = await import("./audioClient");
  await audioClient.joinVoiceSession("room", "self");
  await audioClient.addRemoteParticipant("friend");
  await audioClient.setParticipantEffect("friend", "echo", 0.4);
  requests.length = 0;
  await audioClient.reconnectVoiceSession();
  expect(requests).toContainEqual({ command: "AddRemoteParticipant", args: { participantId: "friend" } });
  expect(requests).toContainEqual({ command: "SetRemoteEffect", args: { participantId: "friend", effect: "echo", value: 0.4 } });
  await audioClient.joinVoiceSession("new-room", "self");
  requests.length = 0;
  await audioClient.joinVoiceSession("new-room", "self");
  expect(requests.filter(request => request.command === "AddRemoteParticipant")).toEqual([{
    command: "AddRemoteParticipant",
    args: { participantId: "__room_server_mix__" }
  }]);
});
