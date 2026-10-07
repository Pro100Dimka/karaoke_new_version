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

  it.each(["", "0", "1"])(
    "does not upload this profile's logs or room diagnostics when the env key is present as %j",
    async (value) => {
      vi.stubEnv("AD_VOICE_DISABLE_SERVER_LOGS", value);
      const fetch = vi.fn(async () => new Response(null, { status: 204 }));
      vi.stubGlobal("fetch", fetch);
      const { roomServerRequest } = await import("./RoomServerTransport");

      for (const path of ["/app-logs", "/rooms/room-1/diagnostics"])
        await expect(roomServerRequest({ method: "POST", path, body: {} }))
          .resolves.toEqual({ status: 204, ok: true, body: null });
      expect(fetch).not.toHaveBeenCalled();

      await expect(roomServerRequest({ method: "POST", path: "/rooms/room-1/leave" }))
        .resolves.toEqual({ status: 204, ok: true, body: null });
      expect(fetch).toHaveBeenCalledOnce();
      expect(new URL(String(fetch.mock.calls[0]?.[0])).pathname).toBe("/rooms/room-1/leave");
    },
  );

  it("applies the packaged profile's log preference to uploads without blocking room controls", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const transport = await import("./RoomServerTransport");
    transport.setServerLogUploadsDisabled(true);

    await expect(transport.roomServerRequest({ method: "POST", path: "/app-logs", body: {} }))
      .resolves.toEqual({ status: 204, ok: true, body: null });
    await expect(transport.roomServerRequest({ method: "POST", path: "/rooms/room-1/diagnostics", body: {} }))
      .resolves.toEqual({ status: 204, ok: true, body: null });
    expect(fetch).not.toHaveBeenCalled();

    await transport.roomServerRequest({ method: "GET", path: "/rooms/room-1" });
    expect(fetch).toHaveBeenCalledOnce();
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

  it("applies only the latest gain after rapid changes to one participant", async () => {
    const gainPosts: number[] = [];
    const finishPosts: Array<() => void> = [];
    let appliedGain = 1;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        if (path === "/voice/join")
          return new Response(JSON.stringify({ voiceToken: "0000000000000001" }));
        if (path !== "/voice/participant-gain")
          return new Response(null, { status: 204 });
        const gain = Number(JSON.parse(String(init?.body)).gain);
        gainPosts.push(gain);
        await new Promise<void>((resolve) => finishPosts.push(resolve));
        appliedGain = gain;
        return new Response(null, { status: 204 });
      }),
    );
    const transport = await import("./RoomServerTransport");
    await transport.joinRoomVoice("room-1", "host");

    const first = transport.setRoomVoiceParticipantGain("guest", 0.25);
    await vi.waitFor(() => expect(gainPosts).toHaveLength(1));
    const later = Array.from({ length: 127 }, (_, index) =>
      transport.setRoomVoiceParticipantGain("guest", index === 126 ? 1.2 : index / 100),
    );
    await Promise.resolve();
    expect(gainPosts).toEqual([0.25]);

    finishPosts[0]!();
    await vi.waitFor(() => expect(gainPosts).toHaveLength(2));
    expect(gainPosts[1]).toBe(1.2);
    finishPosts[1]!();
    await Promise.all([first, ...later]);
    expect(appliedGain).toBe(1.2);
    await transport.leaveRoomVoice();
  });

  it("sends the latest gain after an older request fails", async () => {
    const gainPosts: number[] = [];
    let finishFirst!: () => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        if (path === "/voice/join")
          return new Response(JSON.stringify({ voiceToken: "0000000000000001" }));
        if (path !== "/voice/participant-gain")
          return new Response(null, { status: 204 });
        const gain = Number(JSON.parse(String(init?.body)).gain);
        gainPosts.push(gain);
        if (gainPosts.length === 1)
          await new Promise<void>((resolve) => { finishFirst = resolve; });
        return new Response(null, { status: gain === 1.2 ? 204 : 503 });
      }),
    );
    const transport = await import("./RoomServerTransport");
    await transport.joinRoomVoice("room-1", "host");

    const old = transport.setRoomVoiceParticipantGain("guest", 0.25);
    await vi.waitFor(() => expect(gainPosts).toEqual([0.25]));
    const latest = transport.setRoomVoiceParticipantGain("guest", 1.2);
    finishFirst();
    await expect(Promise.all([old, latest])).resolves.toEqual([undefined, undefined]);
    expect(gainPosts).toEqual([0.25, 1.2]);

    await expect(transport.setRoomVoiceParticipantGain("guest", 0.7))
      .rejects.toThrow("503");
    await transport.leaveRoomVoice();
  });

  it("retries a gain reselected while its earlier request was failing", async () => {
    const gainPosts: number[] = [];
    let finishFirst!: () => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        if (path === "/voice/join")
          return new Response(JSON.stringify({ voiceToken: "0000000000000001" }));
        if (path !== "/voice/participant-gain")
          return new Response(null, { status: 204 });
        gainPosts.push(Number(JSON.parse(String(init?.body)).gain));
        if (gainPosts.length === 1)
          await new Promise<void>((resolve) => { finishFirst = resolve; });
        return new Response(null, { status: gainPosts.length === 1 ? 503 : 204 });
      }),
    );
    const transport = await import("./RoomServerTransport");
    await transport.joinRoomVoice("room-1", "host");

    const old = transport.setRoomVoiceParticipantGain("guest", 0.7);
    await vi.waitFor(() => expect(gainPosts).toEqual([0.7]));
    const retry = transport.setRoomVoiceParticipantGain("guest", 0.7);
    finishFirst();
    await expect(Promise.all([old, retry])).resolves.toEqual([undefined, undefined]);
    expect(gainPosts).toEqual([0.7, 0.7]);
    await transport.leaveRoomVoice();
  });

  it("does not send a queued gain from an earlier voice session after rejoin", async () => {
    const gainPosts: Array<{ gain: number; voiceToken: string }> = [];
    let joinCount = 0;
    let finishOld!: () => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        if (path === "/voice/join")
          return new Response(JSON.stringify({
            voiceToken: String(++joinCount).padStart(16, "0"),
          }));
        if (path !== "/voice/participant-gain")
          return new Response(null, { status: 204 });
        const { gain, voiceToken } = JSON.parse(String(init?.body)) as {
          gain: number;
          voiceToken: string;
        };
        gainPosts.push({ gain, voiceToken });
        if (voiceToken === "0000000000000001")
          await new Promise<void>((resolve) => { finishOld = resolve; });
        return new Response(null, { status: 204 });
      }),
    );
    const transport = await import("./RoomServerTransport");
    await transport.joinRoomVoice("room-1", "host");

    const old = transport.setRoomVoiceParticipantGain("guest", 0.25);
    await vi.waitFor(() => expect(gainPosts).toHaveLength(1));
    const obsolete = transport.setRoomVoiceParticipantGain("guest", 0.4);
    await transport.joinRoomVoice("room-1", "host");
    await transport.setRoomVoiceParticipantGain("guest", 1.2);
    finishOld();
    await Promise.all([old, obsolete]);

    expect(gainPosts).toEqual([
      { gain: 0.25, voiceToken: "0000000000000001" },
      { gain: 1.2, voiceToken: "0000000000000002" },
    ]);
    await transport.leaveRoomVoice();
  });
});
