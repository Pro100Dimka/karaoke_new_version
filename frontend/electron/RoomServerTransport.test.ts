import { beforeEach, describe, expect, it, vi } from "vitest";

const sendAudioRequest = vi.fn();
vi.mock("./AudioServiceTransport", () => ({ sendAudioRequest }));

describe("central room voice transport", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    sendAudioRequest.mockReset();
    sendAudioRequest.mockImplementation(
      async ({ command }: { command: string }) => ({
        status: 0,
        text:
          command === "JoinMediaSession"
            ? "MediaSessionJoined localPort=41001"
            : "Ok",
      }),
    );
  });

  it("builds the room API address from one host and the dedicated room port", async () => {
    vi.stubEnv("AD_VOICE_ROOM_SERVER_HOST", "rooms.example.com");
    vi.stubEnv("AD_VOICE_ROOM_SERVER_PORT", "9443");

    const transport = await import("./RoomServerTransport");

    expect(transport.roomServerApiBase).toBe("http://rooms.example.com:9443");
  });

  it("never installs or discovers a direct peer that could bypass the server mix", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        requests.push({ path, body });
        const responseBody =
          path === "/voice/join"
            ? { voiceToken: "0000000000000001" }
            : path === "/voice/peers"
              ? {
                  peers: [
                    {
                      participantId: "guest",
                      host: "127.0.0.1",
                      port: 41002,
                      voiceToken: "0000000000000002",
                    },
                  ],
                }
              : null;
        return new Response(
          responseBody === null ? null : JSON.stringify(responseBody),
          {
            status: path === "/voice/candidate" ? 204 : 200,
          },
        );
      }),
    );
    const transport = await import("./RoomServerTransport");

    await transport.joinRoomVoice("room-1", "host");

    expect(
      requests.some(
        ({ path }) => path === "/voice/candidate" || path === "/voice/peers",
      ),
    ).toBe(false);
    expect(
      sendAudioRequest.mock.calls.some(
        ([request]) => request.command === "SetDirectPeer",
      ),
    ).toBe(false);
    await transport.leaveRoomVoice();
  });

  it("reads pushed microphone levels locally without polling the room server", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        requests.push({ path, body });
        const responseBody =
          path === "/voice/join" ? { voiceToken: "0000000000000001" } : null;
        return new Response(
          responseBody === null ? null : JSON.stringify(responseBody),
          { status: 200 },
        );
      }),
    );
    const transport = await import("./RoomServerTransport");

    await transport.joinRoomVoice("room-1", "host");
    transport.acceptRoomVoiceLevels({
      type: "voiceLevels",
      roomId: "room-1",
      levels: { host: 0.2, guest: 0.7 },
    });

    await expect(transport.roomVoiceLevels()).resolves.toEqual({
      host: 0.2,
      guest: 0.7,
    });
    expect(
      requests
        .map(({ path }) => path)
        .filter((path) => path === "/voice/levels"),
    ).toEqual([]);
    await transport.leaveRoomVoice();
  });

  it("rate-limits the legacy HTTP fallback until the server starts pushing levels", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        requests.push(path);
        return new Response(
          JSON.stringify(
            path === "/voice/join"
              ? { voiceToken: "0000000000000001" }
              : { host: 0.4 },
          ),
          { status: 200 },
        );
      }),
    );
    const transport = await import("./RoomServerTransport");
    await transport.joinRoomVoice("room-1", "host");

    await expect(transport.roomVoiceLevels()).resolves.toEqual({ host: 0.4 });
    await expect(transport.roomVoiceLevels()).resolves.toEqual({ host: 0.4 });

    expect(requests.filter((path) => path === "/voice/levels")).toHaveLength(1);
    await transport.leaveRoomVoice();
  });
});
