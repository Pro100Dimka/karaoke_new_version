import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./SocialIdentity", () => ({ deviceSecret: async () => "secret-of-this-computer" }));

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static made: FakeSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  constructor(readonly url: string) {
    super();
    FakeSocket.made.push(this);
  }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  open() { this.readyState = FakeSocket.OPEN; this.dispatchEvent(new Event("open")); }
  push(message: unknown) { this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(message) })); }
}

describe("friends socket", () => {
  beforeEach(() => {
    FakeSocket.made = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("says who it is on connecting, sends its presence only when it changes, and passes pushes on", async () => {
    const { createSocialSocket } = await import("./SocialSocket");
    const delivered: unknown[] = [];
    const socket = createSocialSocket("ws://server/social/socket", message => delivered.push(message));
    socket.setPresence({ displayName: "Anna", participantId: "seat", roomId: null });
    socket.start();
    await vi.waitFor(() => expect(FakeSocket.made).toHaveLength(1));
    const [connection] = FakeSocket.made;
    connection.open();
    connection.push({ type: "inbox", friends: [] });
    socket.setPresence({ displayName: "Anna", participantId: "seat", roomId: "room" });

    expect(connection.sent).toEqual([
      { device: "secret-of-this-computer", displayName: "Anna", participantId: "seat", roomId: null },
      { displayName: "Anna", participantId: "seat", roomId: "room" },
    ]);
    expect(delivered).toEqual([{ type: "inbox", friends: [] }]);
    socket.stop();
  });

  it("reports going offline and connects again with growing pauses, not by asking repeatedly", async () => {
    const { createSocialSocket } = await import("./SocialSocket");
    const delivered: unknown[] = [];
    const socket = createSocialSocket("ws://server/social/socket", message => delivered.push(message));
    socket.start();
    await vi.waitFor(() => expect(FakeSocket.made).toHaveLength(1));
    FakeSocket.made[0].close();
    expect(delivered).toEqual([{ type: "offline" }]);
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.made).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.made).toHaveLength(2);
    FakeSocket.made[1].close();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(FakeSocket.made).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.made).toHaveLength(3);
    socket.stop();
  });
});
