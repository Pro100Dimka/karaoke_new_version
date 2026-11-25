import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const disk = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
}));
vi.mock('node:fs', () => ({ ...disk, default: disk }));
vi.mock('node:fs/promises', () => ({ ...disk, default: disk }));
vi.mock('./RoomServerTransport', () => ({
  roomServerRequest: vi.fn(),
  serverLogUploadsDisabled: () => false,
}));
vi.mock('./RoomIdentity', () => ({ roomParticipantId: vi.fn() }));

import { AppLogUploader } from './AppLogUploader';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  disk.writeFile.mockResolvedValue(undefined);
  disk.rename.mockResolvedValue(undefined);
  disk.rm.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('keeps the event loop available while saving offline logs and waits for their publication', async () => {
  const writing = deferred();
  disk.writeFile.mockReturnValueOnce(writing.promise);
  const logs = new AppLogUploader(async () => {
    throw new Error('offline');
  }, '/profile/queue.json');
  for (let index = 0; index < 1000; index++)
    logs.add('python', 'error', `entry ${index} ${'x'.repeat(4000)}`);
  const finished = vi.fn();
  const stopped = logs.stop().then(finished);
  const input = vi.fn();
  setTimeout(input, 0);
  await vi.advanceTimersByTimeAsync(0);
  expect(input).toHaveBeenCalledOnce();
  expect(disk.writeFileSync).not.toHaveBeenCalled();
  expect(disk.renameSync).not.toHaveBeenCalled();
  expect(disk.writeFile).toHaveBeenCalledOnce();
  expect(JSON.parse(disk.writeFile.mock.calls[0]![1])).toHaveLength(1000);
  expect(finished).not.toHaveBeenCalled();
  expect(disk.rename).not.toHaveBeenCalled();
  writing.resolve();
  await stopped;
  expect(disk.rename).toHaveBeenCalledExactlyOnceWith(
    '/profile/queue.json.tmp',
    '/profile/queue.json',
  );
  expect(finished).toHaveBeenCalledOnce();
});

it('includes logs accepted during a pending disk write before shutdown completes', async () => {
  const writing = deferred();
  const replacement = deferred();
  disk.writeFile
    .mockReturnValueOnce(writing.promise)
    .mockReturnValueOnce(replacement.promise);
  const logs = new AppLogUploader(async () => {
    throw new Error('offline');
  }, '/profile/queue.json');
  logs.add('python', 'error', 'first');
  const finished = vi.fn();
  const stopped = logs.stop().then(finished);
  await vi.advanceTimersByTimeAsync(0);
  expect(disk.writeFile).toHaveBeenCalledOnce();
  logs.add('python', 'error', 'accepted during the save');
  writing.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(disk.writeFile).toHaveBeenCalledTimes(2);
  expect(
    JSON.parse(disk.writeFile.mock.calls[1]![1]).map(
      (entry: { message: string }) => entry.message,
    ),
  ).toEqual(['first', 'accepted during the save']);
  expect(finished).not.toHaveBeenCalled();
  replacement.resolve();
  await stopped;
  expect(disk.rename).toHaveBeenCalledTimes(2);
  expect(finished).toHaveBeenCalledOnce();
});

it('persists only the final queue after draining online batches', async () => {
  const send = vi.fn(async () => undefined);
  const logs = new AppLogUploader(send, '/profile/queue.json');
  for (let index = 0; index < 1000; index++)
    logs.add('python', 'info', `entry ${index}`);
  await logs.stop();
  expect(send).toHaveBeenCalledTimes(10);
  expect(disk.writeFileSync).not.toHaveBeenCalled();
  expect(disk.rmSync).not.toHaveBeenCalled();
  expect(disk.writeFile).not.toHaveBeenCalled();
  expect(disk.rm).toHaveBeenCalledExactlyOnceWith('/profile/queue.json', {
    force: true,
  });
});

it('serializes a late upload completion behind the pending disk write', async () => {
  const upload = deferred();
  const writing = deferred();
  disk.writeFile.mockReturnValueOnce(writing.promise);
  const logs = new AppLogUploader(() => upload.promise, '/profile/queue.json');
  logs.add('python', 'error', 'pending');
  const uploading = logs.flush();
  const stopped = logs.stop();
  await vi.advanceTimersByTimeAsync(1200);
  expect(disk.writeFile).toHaveBeenCalledOnce();
  upload.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(disk.rm).not.toHaveBeenCalled();
  writing.resolve();
  await Promise.all([stopped, uploading]);
  expect(disk.rename).toHaveBeenCalledOnce();
  expect(disk.rm).toHaveBeenCalledOnce();
  expect(disk.rename.mock.invocationCallOrder[0]).toBeLessThan(
    disk.rm.mock.invocationCallOrder[0]!,
  );
});

it('allows shutdown and a later persistence attempt after disk failure', async () => {
  const upload = deferred();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  disk.writeFile.mockRejectedValueOnce(new Error('disk unavailable'));
  const logs = new AppLogUploader(() => upload.promise, '/profile/queue.json');
  logs.add('python', 'error', 'pending');
  const uploading = logs.flush();
  const stopped = logs.stop();
  await vi.advanceTimersByTimeAsync(1200);
  await stopped;
  expect(warning).toHaveBeenCalledOnce();
  upload.resolve();
  await uploading;
  expect(disk.rm).toHaveBeenCalledOnce();
});

it('does not retry persistence because its own disk failure warning was captured', async () => {
  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  // A mistaken retry can settle so this test fails instead of looping forever.
  disk.writeFile.mockRejectedValueOnce(new Error('disk unavailable'));
  const logs = new AppLogUploader(async () => {
    throw new Error('offline');
  }, '/profile/queue.json');
  logs.captureConsole(console);
  try {
    logs.add('python', 'error', 'pending');
    await logs.stop();
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      'Could not save pending application logs',
      expect.any(Error),
    );
    expect(disk.writeFile).toHaveBeenCalledOnce();
    expect(disk.rename).not.toHaveBeenCalled();
  } finally {
    Object.assign(console, originalConsole);
  }
});
