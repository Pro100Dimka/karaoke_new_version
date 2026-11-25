import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('./AudioServiceTransport', () => ({
  sendAudioRequest: vi.fn(async () => ({ status: 0, text: 'Ok' })),
}));
vi.mock('./RoomIdentity', () => ({
  withRoomKey: async (headers: object) => headers,
}));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const install = async () => {
  const replies: Array<
    (levels: Record<string, number>, status?: number) => void
  > = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const route = new URL(url).pathname;
      if (route === '/voice/levels')
        return new Promise<Response>((resolve) => {
          replies.push((levels, status = 200) =>
            resolve(new Response(JSON.stringify(levels), { status })),
          );
        });
      return new Response(
        JSON.stringify(
          route === '/voice/join' ? { voiceToken: '0000000000000001' } : {},
        ),
      );
    }),
  );
  const transport = await import('./RoomServerTransport');
  await transport.joinRoomVoice('room', 'host');
  return { transport, replies };
};

it('keeps one fallback request while slow responses span several polling intervals', async () => {
  const { transport, replies } = await install();
  const reads = [transport.roomVoiceLevels()];
  for (let interval = 0; interval < 8; interval += 1) {
    await vi.advanceTimersByTimeAsync(1001);
    reads.push(transport.roomVoiceLevels());
  }
  await vi.advanceTimersByTimeAsync(0);
  const count = replies.length;
  for (const reply of replies) reply({ host: 0.4 });
  await Promise.all(reads);
  expect(count).toBe(1);
  await transport.leaveRoomVoice();
});

it('preserves fresh pushed levels when an older HTTP fallback finishes', async () => {
  const { transport, replies } = await install();
  const pending = transport.roomVoiceLevels();
  await vi.advanceTimersByTimeAsync(0);
  transport.acceptRoomVoiceLevels({
    type: 'voiceLevels',
    roomId: 'room',
    levels: { host: 0.9 },
  });
  replies[0]!({ host: 0.1 });
  await expect(pending).resolves.toEqual({ host: 0.9 });
  await expect(transport.roomVoiceLevels()).resolves.toEqual({ host: 0.9 });
  await transport.leaveRoomVoice();
});

it('does not let a previous session clear the new session pending request', async () => {
  const { transport, replies } = await install();
  const previous = transport.roomVoiceLevels();
  await vi.advanceTimersByTimeAsync(0);
  await transport.joinRoomVoice('room', 'new-host');
  const current = transport.roomVoiceLevels();
  await vi.advanceTimersByTimeAsync(0);
  replies[0]!({ host: 0.2 });
  await expect(previous).resolves.toEqual({});
  await vi.advanceTimersByTimeAsync(1001);
  const extra = transport.roomVoiceLevels();
  await vi.advanceTimersByTimeAsync(0);
  const count = replies.length;
  for (const reply of replies.slice(1)) reply({ guest: 0.7 });
  await Promise.all([current, extra]);
  expect(count).toBe(2);
  await transport.leaveRoomVoice();
});

it('allows a later fallback after a failed response releases its pending slot', async () => {
  const { transport, replies } = await install();
  const first = transport.roomVoiceLevels();
  await vi.advanceTimersByTimeAsync(0);
  replies[0]!({}, 503);
  await expect(first).resolves.toEqual({});
  await vi.advanceTimersByTimeAsync(1001);
  const retry = transport.roomVoiceLevels();
  await vi.advanceTimersByTimeAsync(0);
  expect(replies).toHaveLength(2);
  replies[1]!({ host: 0.6 });
  await expect(retry).resolves.toEqual({ host: 0.6 });
  await transport.leaveRoomVoice();
});
