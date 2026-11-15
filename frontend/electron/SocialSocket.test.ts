import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./SocialIdentity', () => ({
  deviceSecret: async () => 'secret-of-this-computer',
}));

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static made: FakeSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  constructor(readonly url: string) {
    super();
    FakeSocket.made.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }
  push(message: unknown) {
    this.dispatchEvent(
      Object.assign(new Event('message'), { data: JSON.stringify(message) }),
    );
  }
}

describe('friends socket', () => {
  it('stays offline without breaking startup for an insecure server', async () => {
    const { createSocialSocket } = await import('./SocialSocket');
    const deliver = vi.fn();
    const socket = createSocialSocket('ws://server/social/socket', deliver);
    socket.start();
    await Promise.resolve();
    expect(FakeSocket.made).toHaveLength(0);
    expect(deliver).toHaveBeenCalledWith({ type: 'offline' });
    socket.stop();
  });
  beforeEach(() => {
    FakeSocket.made = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('says who it is on connecting, sends its presence only when it changes, and passes pushes on', async () => {
    const { createSocialSocket } = await import('./SocialSocket');
    const delivered: unknown[] = [];
    const socket = createSocialSocket('wss://server/social/socket', (message) =>
      delivered.push(message),
    );
    const initial = socket.setPresence({
      displayName: 'Anna',
      participantId: 'seat',
      roomId: null,
    });
    socket.start();
    await vi.waitFor(() => expect(FakeSocket.made).toHaveLength(1));
    const [connection] = FakeSocket.made;
    connection.open();
    connection.push({ type: 'inbox', friends: [] });
    const changed = socket.setPresence({
      displayName: 'Anna',
      participantId: 'seat',
      roomId: 'room',
    });

    expect(connection.sent).toEqual([
      {
        device: 'secret-of-this-computer',
        displayName: 'Anna',
        participantId: 'seat',
        roomId: null,
        revision: 1,
      },
      {
        displayName: 'Anna',
        participantId: 'seat',
        roomId: 'room',
        revision: 2,
      },
    ]);
    expect(delivered).toEqual([{ type: 'inbox', friends: [] }]);
    connection.push({ type: 'presenceAck', revision: 2 });
    await Promise.all([initial, changed]);
    socket.stop();
  });

  it('reports going offline and connects again with growing pauses, not by asking repeatedly', async () => {
    const { createSocialSocket } = await import('./SocialSocket');
    const delivered: unknown[] = [];
    const socket = createSocialSocket('wss://server/social/socket', (message) =>
      delivered.push(message),
    );
    socket.start();
    await vi.waitFor(() => expect(FakeSocket.made).toHaveLength(1));
    FakeSocket.made[0].close();
    expect(delivered).toEqual([{ type: 'offline' }]);
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

  it.each(['ack', 'close', 'stop', 'timeout'] as const)(
    'settles presence on %s',
    async (outcome) => {
      const { createSocialSocket } = await import('./SocialSocket');
      const socket = createSocialSocket('wss://server/social/socket', vi.fn());
      socket.start();
      await vi.waitFor(() => expect(FakeSocket.made).toHaveLength(1));
      const [connection] = FakeSocket.made;
      connection.open();

      let applied = false;
      let failure: unknown;
      const update = socket
        .setPresence({
          displayName: 'Anna',
          participantId: 'seat',
          roomId: 'room',
        })
        .then(
          () => {
            applied = true;
          },
          (error) => {
            failure = error;
          },
        );
      await Promise.resolve();
      expect(applied).toBe(false);
      expect(connection.sent.at(-1)).toMatchObject({
        roomId: 'room',
        revision: 1,
      });

      await {
        ack: async () => connection.push({ type: 'presenceAck', revision: 1 }),
        close: async () => connection.close(),
        stop: async () => socket.stop(),
        timeout: async () => vi.advanceTimersByTimeAsync(15_000),
      }[outcome]();
      await Promise.resolve();
      if (outcome === 'ack') {
        await update;
        expect(applied).toBe(true);
      } else {
        expect(failure).toBeInstanceOf(Error);
        expect(applied).toBe(false);
        await update;
      }
      socket.stop();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
