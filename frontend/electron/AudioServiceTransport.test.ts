import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { createConnection } = vi.hoisted(() => ({ createConnection: vi.fn() }));
vi.mock('node:net', () => ({ createConnection }));

const sockets: Array<ReturnType<typeof socket>> = [];
const socket = () =>
  Object.assign(new EventEmitter(), { write: vi.fn(), destroy: vi.fn() });
let reply: (connection: ReturnType<typeof socket>, request: string) => void;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  sockets.length = 0;
  reply = (connection) => {
    connection.emit('data', Buffer.from('0|Ok\n'));
    connection.emit('end');
  };
  createConnection.mockReset().mockImplementation(() => {
    const connection = socket();
    connection.write.mockImplementation((request: string) =>
      reply(connection, request),
    );
    sockets.push(connection);
    queueMicrotask(() => connection.emit('connect'));
    return connection;
  });
});
afterEach(() => vi.useRealTimers());

it('streams fragmented notifications over one connection and reconnects after a lost stream', async () => {
  reply = () => {};
  const transport = await import('./AudioServiceTransport');
  expect(transport).toHaveProperty('subscribeAudioNotifications');
  if (!('subscribeAudioNotifications' in transport)) return;
  const received = vi.fn();
  const stop = transport.subscribeAudioNotifications('GetPlaybackSnapshot', 16, received);
  await vi.advanceTimersByTimeAsync(0);
  const payload = Buffer.from('1000000|0|PlaybackState: 3\nInputPitchHistory: 1,2,3,440\n');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  for (const byte of Buffer.concat([header, payload, header, payload]))
    sockets[0]?.emit('data', Buffer.from([byte]));
  expect(received).toHaveBeenCalledTimes(2);
  expect(received).toHaveBeenLastCalledWith({
    status: 0, text: 'PlaybackState: 3\nInputPitchHistory: 1,2,3,440', observedAt: 1000000,
  });
  expect(createConnection).toHaveBeenCalledOnce();
  sockets[0]?.emit('end');
  await vi.advanceTimersByTimeAsync(300);
  expect(createConnection).toHaveBeenCalledTimes(2);
  stop();
  await vi.advanceTimersByTimeAsync(5000);
  expect(createConnection).toHaveBeenCalledTimes(2);
  expect(sockets[1]?.destroy).toHaveBeenCalled();
});

it.each(['oversized', 'malformed', 'stalled'])(
  'resynchronizes a %s notification stream and stops retries on cleanup', async (kind) => {
    reply = () => {};
    const { subscribeAudioNotifications } = await import('./AudioServiceTransport');
    const received = vi.fn();
    const stop = subscribeAudioNotifications('GetSpectrum', 50, received);
    await vi.advanceTimersByTimeAsync(0);
    if (kind !== 'stalled') {
      const payload = Buffer.from('bad|0|bands=0.5\n');
      const header = Buffer.alloc(4);
      header.writeUInt32LE(kind === 'oversized' ? (1 << 20) + 1 : payload.length);
      sockets[0]?.emit('data', Buffer.concat([header, payload]));
    } else {
      await vi.advanceTimersByTimeAsync(3000);
    }
    expect(received).toHaveBeenCalledWith(null);
    await vi.advanceTimersByTimeAsync(250);
    expect(createConnection).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(createConnection).toHaveBeenCalledTimes(2);
  },
);

it.each([['Play', 16], ['GetSpectrum', 0], ['GetPlaybackSnapshot', Infinity]])(
  'rejects an invalid subscription %s at %s', async (command, interval) => {
    const { subscribeAudioNotifications } = await import('./AudioServiceTransport');
    expect(() => subscribeAudioNotifications(command, interval, vi.fn())).toThrow();
    expect(createConnection).not.toHaveBeenCalled();
  },
);

it('decodes a multibyte device name split across pipe reads', async () => {
  reply = (connection) => {
    const bytes = Buffer.from('0|Мікрофон 🎤\n');
    for (const byte of bytes) connection.emit('data', Buffer.from([byte]));
    connection.emit('end');
  };
  const { sendAudioRequest } = await import('./AudioServiceTransport');
  await expect(sendAudioRequest({ command: 'GetDevices' })).resolves.toEqual({
    status: 0,
    text: 'Мікрофон 🎤',
  });
});

it('retains all lines when a response spans several pipe reads', async () => {
  reply = () => {};
  const { sendAudioRequest } = await import('./AudioServiceTransport');
  const response = sendAudioRequest({ command: 'GetServiceState' }, 100);
  await vi.advanceTimersByTimeAsync(0);
  sockets[0]?.emit('data', Buffer.from('0|First line\n'));
  await vi.advanceTimersByTimeAsync(1);
  expect(sockets[0]?.destroy).not.toHaveBeenCalled();
  sockets[0]?.emit('data', Buffer.from('Second line\n'));
  sockets[0]?.emit('end');
  await expect(response).resolves.toEqual({
    status: 0,
    text: 'First line\nSecond line',
  });
  expect(sockets[0]?.destroy).toHaveBeenCalledOnce();
});

it.each([
  { command: 'Play|ignored' },
  { command: 'Play\n1|Stop' },
  { command: 'SetGain', args: { 'input|output': 1 } },
  { command: 'LoadSong', args: { path: 'song|rate=2' } },
  { command: 'LoadSong', args: { path: 'song\n' } },
  { command: 'LoadSong', args: { path: 'song\0' } },
  { command: 'SetGain', args: { value: NaN } },
  { command: 'LoadSong', args: { path: 'я'.repeat(4096) } },
])(
  'rejects malformed control frames before opening the pipe, case %#',
  async (request) => {
    const { sendAudioRequest } = await import('./AudioServiceTransport');
    await expect(sendAudioRequest(request)).rejects.toThrow();
    expect(createConnection).not.toHaveBeenCalled();
  },
);

it.each(['|Ok\n', ' |Ok\n', '0|truncated'])(
  'rejects a malformed or incomplete reply, case %#',
  async (response) => {
    reply = (connection) => {
      connection.emit('data', Buffer.from(response));
      connection.emit('end');
    };
    const { sendAudioRequest } = await import('./AudioServiceTransport');
    await expect(
      sendAudioRequest({ command: 'GetDiagnostics' }),
    ).rejects.toThrow(/Malformed/);
  },
);

it('rejects an oversized response without retaining unlimited bytes', async () => {
  reply = (connection) => {
    connection.emit('data', Buffer.from('0|' + 'x'.repeat(1 << 20) + '\n'));
    connection.emit('end');
  };
  const { sendAudioRequest } = await import('./AudioServiceTransport');
  await expect(sendAudioRequest({ command: 'GetDiagnostics' })).rejects.toThrow(
    /too large/,
  );
  expect(sockets[0]?.destroy).toHaveBeenCalled();
});

it('does not execute an expired command after it waits behind another command', async () => {
  reply = () => {};
  const { sendAudioRequest } = await import('./AudioServiceTransport');
  const first = sendAudioRequest({ command: 'GetDiagnostics' }, 100);
  const second = sendAudioRequest({ command: 'Play' }, 20);
  const firstFailure = expect(first).rejects.toThrow(/timed out/);
  const secondFailure = expect(second).rejects.toThrow(/timed out/);
  await vi.advanceTimersByTimeAsync(200);
  await Promise.all([firstFailure, secondFailure]);
  expect(createConnection).toHaveBeenCalledOnce();
});

it('bounds pending commands when a client floods a stalled pipe', async () => {
  reply = () => {};
  const { sendAudioRequest } = await import('./AudioServiceTransport');
  let rejected = 0;
  const requests = Array.from({ length: 1000 }, () =>
    sendAudioRequest({ command: 'GetDiagnostics' }, 100).catch(() => {
      rejected++;
    }),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(rejected).toBeGreaterThan(0);
  await vi.advanceTimersByTimeAsync(101);
  await Promise.all(requests);
});

it('snapshots accepted arguments before they wait in the queue', async () => {
  reply = () => {};
  const { sendAudioRequest } = await import('./AudioServiceTransport');
  const first = sendAudioRequest({ command: 'GetDiagnostics' });
  const args = { value: 0.5 };
  const next = sendAudioRequest({ command: 'SetGain', args });
  args.value = 10;
  await vi.advanceTimersByTimeAsync(0);
  sockets[0]?.emit('data', Buffer.from('0|Ok\n'));
  sockets[0]?.emit('end');
  reply = (connection) => {
    connection.emit('data', Buffer.from('0|Ok\n'));
    connection.emit('end');
  };
  await Promise.all([first, next]);
  expect(sockets[1]?.write).toHaveBeenCalledWith('1|SetGain|value=0.5\n');
});
