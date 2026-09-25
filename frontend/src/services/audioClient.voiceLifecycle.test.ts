import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => Reflect.deleteProperty(window, "desktop"));

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
  await audioClient.joinVoiceSession("room", "self");
  expect(requests).toContainEqual({ command: "AddRemoteParticipant", args: { participantId: "friend" } });
  expect(requests).toContainEqual({ command: "SetRemoteEffect", args: { participantId: "friend", effect: "echo", value: 0.4 } });
  await audioClient.joinVoiceSession("new-room", "self");
  requests.length = 0;
  await audioClient.joinVoiceSession("new-room", "self");
  expect(requests.some(request => request.command === "AddRemoteParticipant")).toBe(false);
});
