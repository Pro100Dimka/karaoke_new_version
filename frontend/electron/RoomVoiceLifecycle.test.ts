import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sendAudioRequest } = vi.hoisted(() => ({ sendAudioRequest: vi.fn() }));
vi.mock("./AudioServiceTransport", () => ({ sendAudioRequest }));

const response = (path: string) => new Response(JSON.stringify(path === "/voice/join"
  ? { voiceToken: "0000000000000001" } : path === "/voice/peers" ? { peers: [] } : {}));
const install = (handle?: (path: string, init: RequestInit) => Promise<Response> | Response | undefined) => {
  const fetch = vi.fn((url: string, init: RequestInit) =>
    Promise.resolve(handle?.(new URL(url).pathname, init) ?? response(new URL(url).pathname)));
  vi.stubGlobal("fetch", fetch);
  return fetch;
};

describe("room voice lifecycle", () => {
  beforeEach(() => {
    vi.resetModules(); vi.useFakeTimers();
    sendAudioRequest.mockReset().mockImplementation(async ({ command }) => ({
      status: 0, text: command === "JoinMediaSession" ? "MediaSessionJoined localPort=41001" : "Ok",
    }));
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("owns exactly one peer refresh timer across repeated joins and none after leave", async () => {
    install();
    const transport = await import("./RoomServerTransport");
    await transport.joinRoomVoice("room", "host");
    await transport.joinRoomVoice("room", "host");
    expect(vi.getTimerCount()).toBe(1);
    await transport.leaveRoomVoice();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not open a voice session after leave supersedes pending registration", async () => {
    let resolve!: (value: Response) => void;
    install(path => path === "/voice/join" ? new Promise<Response>(done => { resolve = done; }) : undefined);
    const transport = await import("./RoomServerTransport");
    const joining = transport.joinRoomVoice("room", "host").catch(() => undefined);
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    const leaving = transport.leaveRoomVoice();
    resolve(response("/voice/join"));
    await Promise.all([joining, leaving]);
    expect(sendAudioRequest.mock.calls.some(([request]) => request.command === "JoinMediaSession")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the newest join when an older registration returns late", async () => {
    let resolve!: (value: Response) => void;
    install((path, init) => path === "/voice/join" && JSON.parse(String(init.body)).participantId === "old"
      ? new Promise<Response>(done => { resolve = done; }) : undefined);
    const transport = await import("./RoomServerTransport");
    const first = transport.joinRoomVoice("room", "old").catch(() => undefined);
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    const second = transport.joinRoomVoice("room", "new");
    await vi.advanceTimersByTimeAsync(0);
    resolve(response("/voice/join"));
    await Promise.all([first, second]);
    const joins = sendAudioRequest.mock.calls.map(([request]) => request).filter(request => request.command === "JoinMediaSession");
    expect(joins.at(-1)?.args.localParticipantId).toBe("new");
    await transport.leaveRoomVoice();
  });

  it("closes native media when candidate registration fails after native join", async () => {
    install(path => path === "/voice/candidate" ? new Response("{}", { status: 503 }) : undefined);
    const transport = await import("./RoomServerTransport");
    await expect(transport.joinRoomVoice("room", "host")).rejects.toThrow();
    expect(sendAudioRequest.mock.lastCall?.[0].command).toBe("LeaveMediaSession");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows only one peer refresh request in flight", async () => {
    let refreshes = 0;
    let finish!: (value: Response) => void;
    install(path => {
      if (path !== "/voice/peers" || ++refreshes === 1) return undefined;
      return new Promise<Response>(resolve => { finish = resolve; });
    });
    const transport = await import("./RoomServerTransport");
    await transport.joinRoomVoice("room", "host");
    await vi.advanceTimersByTimeAsync(6000);
    expect(refreshes).toBe(2);
    finish(response("/voice/peers"));
    await transport.leaveRoomVoice();
  });

  it("bounds an unreachable control request with an abort deadline", async () => {
    const settled = vi.fn();
    install((_path, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const transport = await import("./RoomServerTransport");
    void transport.roomServerRequest({ method: "GET", path: "/rooms/room" }).then(settled);
    await vi.advanceTimersByTimeAsync(10001);
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ ok: false, status: 503 }));
  });
});
