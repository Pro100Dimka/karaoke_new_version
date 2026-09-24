import { beforeEach, describe, expect, it, vi } from "vitest";

const sendAudioRequest = vi.fn();
vi.mock("./AudioServiceTransport", () => ({ sendAudioRequest }));

describe("room voice direct transport", () => {
  beforeEach(() => {
    vi.resetModules();
    sendAudioRequest.mockReset();
    sendAudioRequest.mockImplementation(async ({ command }: { command: string }) => ({
      status: 0,
      text: command === "JoinMediaSession" ? "MediaSessionJoined localPort=41001" : "Ok",
    }));
  });

  it("advertises the bound port and installs discovered direct peers while retaining relay", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push({ path, body });
      const responseBody = path === "/voice/join"
        ? { voiceToken: "0000000000000001" }
        : path === "/voice/peers"
          ? { peers: [{ participantId: "guest", host: "127.0.0.1", port: 41002,
            voiceToken: "0000000000000002" }] }
          : null;
      return new Response(responseBody === null ? null : JSON.stringify(responseBody), {
        status: path === "/voice/candidate" ? 204 : 200,
      });
    }));
    const transport = await import("./RoomServerTransport");

    await transport.joinRoomVoice("room-1", "host");

    expect(requests.some(({ path, body }) =>
      path === "/voice/candidate" && body.localPort === 41001)).toBe(true);
    expect(sendAudioRequest).toHaveBeenCalledWith({
      command: "SetDirectPeer",
      args: {
        participantId: "guest",
        host: "127.0.0.1",
        port: 41002,
        voiceToken: "0000000000000002",
      },
    });
    await transport.leaveRoomVoice();
  });
});
