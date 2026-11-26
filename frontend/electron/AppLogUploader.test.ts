import { afterEach, expect, it, vi } from 'vitest';
import { AppLogUploader, sendAppLogs } from './AppLogUploader';
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
  rmdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('./TransferPermissions', () => ({
  requestFileDeclaration: async () => 'scoped-report-ticket',
}));

it('sends explicit error reports with redacted recent logs after periodic flushing', async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  const logs = new AppLogUploader(send);
  logs.add('python', 'error', 'Authorization: Bearer private-token');
  await logs.flush();
  send.mockClear();
  const id = await logs.sendReport(
    'Failure details '.repeat(600) +
      ' Authorization: Bearer report-token alice@example.com',
  );
  const entries = send.mock.calls.flatMap(([batch]) => batch);
  expect(
    entries.filter((entry) => entry.source === 'error-report').length,
  ).toBeGreaterThan(1);
  expect(entries.every((entry) => entry.message.includes(id))).toBe(true);
  expect(entries.some((entry) => entry.source === 'python')).toBe(true);
  expect(JSON.stringify(entries)).not.toContain('private-token');
  expect(JSON.stringify(entries)).not.toContain('report-token');
  expect(JSON.stringify(entries)).not.toContain('alice@example.com');
  send.mockClear();
  logs.addSnapshot(
    'audio-diagnostics',
    'SessionState: Running\n'.repeat(300) +
      'Authorization: Bearer private-token\nLastFailureMessage: output failed',
  );
  await logs.flush();
  const snapshots = send.mock.calls.flatMap(([batch]) => batch);
  expect(snapshots.length).toBeGreaterThan(1);
  expect(
    snapshots.every(
      (entry) =>
        entry.source === 'audio-diagnostics' && entry.message.length <= 4096,
    ),
  ).toBe(true);
  expect(JSON.stringify(snapshots)).not.toContain('private-token');
  expect(
    snapshots.every((entry) => entry.message === 'Application event'),
  ).toBe(true);
});

it('does not claim an explicit report was sent when uploading fails', async () => {
  const logs = new AppLogUploader(
    vi.fn().mockRejectedValue(new Error('offline')),
  );
  await expect(logs.sendReport('Failed song')).rejects.toThrow('offline');
});

it('drains more than two batches on shutdown', async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  const logs = new AppLogUploader(send);
  for (let index = 0; index < 350; index++)
    logs.add('electron', 'info', `entry ${index}`);
  await logs.stop();
  expect(send.mock.calls.flatMap(([entries]) => entries)).toHaveLength(350);
});

it('bounds a stalled shutdown and restores the redacted queue on the next start', async () => {
  vi.useFakeTimers();
  const directory = mkdtempSync(join(tmpdir(), 'pending-logs-'));
  const file = join(directory, 'queue.json');
  const logs = new AppLogUploader(() => new Promise(() => undefined), file);
  try {
    logs.add('electron', 'error', 'authorization=secret');
    const stopped = logs.stop();
    await vi.advanceTimersByTimeAsync(1200);
    await stopped;
    expect(readFileSync(file, 'utf8')).not.toContain('secret');
    const send = vi.fn().mockResolvedValue(undefined);
    const resumed = new AppLogUploader(send, file);
    resumed.start();
    await resumed.stop();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toHaveLength(1);
    expect(existsSync(file)).toBe(false);
  } finally {
    rmSync(file, { force: true });
    rmSync(file + '.tmp', { force: true });
    rmdirSync(directory);
  }
});

const transport = vi.hoisted(() => ({
  request: vi.fn(),
  participantId: vi.fn(async () => 'profile-1'),
  disabled: false,
}));
vi.mock('./RoomServerTransport', () => ({
  roomServerRequest: transport.request,
  serverLogUploadsDisabled: () => transport.disabled,
}));
vi.mock('./RoomIdentity', () => ({
  roomParticipantId: transport.participantId,
}));

afterEach(() => {
  vi.useRealTimers();
  transport.disabled = false;
});

it('never queues or uploads diagnostics while consent is absent or withdrawn', async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  const logs = new AppLogUploader(send);
  transport.disabled = true;
  logs.add('python', 'error', 'before consent');
  await logs.flush();
  expect(send).not.toHaveBeenCalled();
  transport.disabled = false;
  logs.add('python', 'error', 'Error status=200');
  await logs.flush();
  expect(
    send.mock.calls.flatMap(([batch]) => batch).map((entry) => entry.message),
  ).toEqual(['Error status=200']);
  logs.add('python', 'error', 'pending at withdrawal');
  transport.disabled = true;
  await logs.discard();
  transport.disabled = false;
  send.mockClear();
  await logs.flush();
  expect(send).not.toHaveBeenCalled();
});

it('uploads timestamped service lines in order and retries a failed batch', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-07T12:00:00.000Z'));
  const send = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(undefined);
  const logs = new AppLogUploader(send);
  logs.start();
  logs.write('audio-service', 'error', Buffer.from('ValueErr'));
  logs.write(
    'audio-service',
    'error',
    Buffer.from('or status=500\nRuntimeError status=501\n'),
  );
  await vi.advanceTimersByTimeAsync(2_000);
  expect(send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[0]?.[0]).toEqual(send.mock.calls[1]?.[0]);
  expect(send.mock.calls[1]?.[0]).toEqual([
    {
      timestamp: '2026-10-07T12:00:00.000Z',
      source: 'audio-service',
      level: 'error',
      message: 'ValueError status=500',
    },
    {
      timestamp: '2026-10-07T12:00:00.000Z',
      source: 'audio-service',
      level: 'error',
      message: 'RuntimeError status=501',
    },
  ]);
  logs.stop();
});

it('bounds offline logs and removes local usernames and room keys', async () => {
  vi.useFakeTimers();
  const send = vi.fn().mockResolvedValue(undefined);
  const logs = new AppLogUploader(send);
  for (let index = 0; index < 1_100; index++)
    logs.add(
      'electron',
      'error',
      `Error ${index} C:\\Users\\Alice\\AppData X-AD-Voice-Room-Key: deadbeef`,
    );
  await logs.flush();
  expect(send.mock.calls[0]?.[0]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source: 'electron',
        message: expect.stringContaining('Dropped 100'),
      }),
    ]),
  );
  const messages = JSON.stringify(send.mock.calls[0]?.[0]);
  expect(messages).not.toContain('Alice');
  expect(messages).not.toContain('deadbeef');
  logs.stop();
});

it('records Electron console errors while preserving the original console', async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  const logs = new AppLogUploader(send);
  const original = vi.fn();
  const target = { error: original };
  logs.captureConsole(target);
  target.error('AudioService', new Error('ASIO driver missing'));
  await logs.flush();
  expect(original).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith([
    expect.objectContaining({
      source: 'electron',
      level: 'error',
      message: 'Error',
    }),
  ]);
});

it('keeps an in-flight batch for retry when the queue fills', async () => {
  let fail!: (error: Error) => void;
  const send = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    )
    .mockResolvedValue(undefined);
  const logs = new AppLogUploader(send);
  logs.add('electron', 'info', 'Error status=1');
  const uploading = logs.flush();
  for (let index = 0; index < 1_000; index++)
    logs.add('electron', 'info', `later ${index}`);
  fail(new Error('offline'));
  await uploading;
  await logs.flush();
  expect(send.mock.calls[1]?.[0]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ message: 'Error status=1' }),
    ]),
  );
});

it('redacts JSON credentials and token query parameters', async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  const logs = new AppLogUploader(send);
  logs.add(
    'python',
    'error',
    'driver error {"apiKey":"secret1","voiceToken":"secret2"} https://x.test/?token=secret3',
  );
  await logs.flush();
  const message = send.mock.calls[0]?.[0][0].message as string;
  expect(message).not.toMatch(/secret[123]/);
  expect(message).toBe('Application event');
});

it.each([
  '{"X-AD-Voice-Room-Key":"private-room-key"}',
  "{'X-AD-Voice-Room-Key': 'private-room-key'}",
  '{"X-AD-Voice-Device":"private-device-secret"}',
  'X-AD-Voice-Device: private-device-secret',
  "{'apiKey': 'private-api-key', 'voiceToken': 'private-voice-token'}",
  '{"Authorization":"Basic private-basic-credential"}',
])(
  'redacts authentication credentials in structured diagnostics: %s',
  async (details) => {
    const send = vi.fn().mockResolvedValue(undefined);
    const logs = new AppLogUploader(send);
    logs.add('electron', 'error', details);
    await logs.flush();
    expect(JSON.stringify(send.mock.calls)).not.toContain('private-');
    expect(send.mock.calls[0][0][0].message).toBe('Application event');
  },
);

it('redacts escaped Windows home paths in Python tracebacks and retains their severity', async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  const logs = new AppLogUploader(send);
  logs.write(
    'python',
    'info',
    Buffer.from(
      String.raw`{"level":"ERROR","exception":"C:\\Users\\Alice\\AppData\\Local\\x.py"}` +
        '\n',
    ),
  );
  await logs.flush();
  expect(send.mock.calls[0]?.[0][0]).toEqual(
    expect.objectContaining({
      level: 'error',
      message: expect.not.stringContaining('Alice'),
    }),
  );
});

it('uses Uvicorn severity prefixes from Python stderr without changing other errors', async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  const logs = new AppLogUploader(send);
  const severities = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'];
  for (const severity of severities)
    logs.write('python', 'error', Buffer.from(`${severity}: Uvicorn event\n`));
  logs.write('python', 'error', Buffer.from('Unclassified Python failure\n'));
  logs.write(
    'audio-service',
    'error',
    Buffer.from('INFO: Native device failure\n'),
  );
  await logs.flush();
  expect(send.mock.calls[0]?.[0]).toEqual([
    ...severities.map((severity) =>
      expect.objectContaining({
        source: 'python',
        level: severity.toLowerCase(),
        message: 'Application event',
      }),
    ),
    expect.objectContaining({
      source: 'python',
      level: 'error',
      message: 'Application event',
    }),
    expect.objectContaining({
      source: 'audio-service',
      level: 'error',
      message: 'Application event',
    }),
  ]);
});

it('withdraws consent while an overflowing batch is still in flight', async () => {
  let complete!: () => void;
  const send = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  const logs = new AppLogUploader(send);
  for (let index = 0; index < 1_001; index++)
    logs.add('python', 'info', `entry ${index}`);
  const sending = logs.flush();
  transport.disabled = true;
  const discarded = logs.discard();
  complete();
  await Promise.all([sending, discarded]);
  transport.disabled = false;
  await logs.flush();
  expect(send).toHaveBeenCalledTimes(1);
});

it('sends logs to the common server outside a room under this profile identity', async () => {
  const entries = [
    {
      timestamp: '2026-10-07T12:00:00Z',
      source: 'renderer',
      level: 'error',
      message: 'failed',
    },
  ];
  transport.request.mockResolvedValueOnce({
    ok: true,
    status: 204,
    body: null,
  });
  await sendAppLogs(entries);
  expect(transport.request).toHaveBeenCalledWith({
    method: 'POST',
    path: '/app-logs',
    body: { clientId: 'profile-1', entries },
  });
});

it('keeps escaped log batches below the server body limit and drains every entry', async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  const logs = new AppLogUploader(send);
  for (let index = 0; index < 100; index++)
    logs.add('python', 'error', '\\'.repeat(4_096));
  let sent = 0;
  for (let attempt = 0; attempt < 3 && sent < 100; attempt++) {
    await logs.flush();
    const entries = send.mock.calls[attempt]?.[0] as unknown[];
    expect(
      Buffer.byteLength(JSON.stringify({ clientId: '0'.repeat(32), entries })),
    ).toBeLessThanOrEqual(512 * 1024);
    sent += entries.length;
  }
  expect(send).toHaveBeenCalledTimes(1);
  expect(sent).toBe(100);
  expect(
    send.mock.calls[0][0].every(
      (entry: { message: string }) => entry.message === 'Application event',
    ),
  ).toBe(true);
});
