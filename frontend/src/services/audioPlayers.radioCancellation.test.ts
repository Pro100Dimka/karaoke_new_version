import { afterEach, expect, it, vi } from 'vitest';
import { createAudioPlayers, type AudioPlayerOperations } from './audioPlayers';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const setup = () => {
  const operations: AudioPlayerOperations = {
    command: vi.fn(async () => ''),
    diagnostics: vi.fn(async () => ({ RadioState: '2' })),
    ensureSession: vi.fn(async () => {}),
    snapshot: vi.fn(),
    pythonRequest: vi.fn(),
    sampleRate: vi.fn(),
  };
  return { players: createAudioPlayers(operations), operations };
};

afterEach(() => vi.useRealTimers());

it('does not load an obsolete radio station after Stop during audio startup', async () => {
  const { players, operations } = setup();
  const startup = deferred<void>();
  vi.mocked(operations.ensureSession).mockReturnValueOnce(startup.promise);
  const loading = players.loadRadio('https://radio.test/old');
  const cancelled = loading.catch((error: unknown) => error);
  await players.stopRadio();
  startup.resolve();
  expect(await cancelled).toEqual(new Error('Radio loading cancelled'));

  expect(operations.command).toHaveBeenCalledExactlyOnceWith('StopRadio');
  expect(operations.diagnostics).not.toHaveBeenCalled();
});

it('keeps the new station when an older startup finishes later', async () => {
  const { players, operations } = setup();
  const startup = deferred<void>();
  vi.mocked(operations.ensureSession).mockReturnValueOnce(startup.promise);
  const old = players.loadRadio('https://radio.test/old');
  const cancelled = old.catch((error: unknown) => error);
  await players.loadRadio('https://radio.test/new');
  startup.resolve();
  expect(await cancelled).toEqual(new Error('Radio loading cancelled'));

  expect(operations.command).toHaveBeenCalledExactlyOnceWith(
    'LoadRadioStation',
    {
      url: 'https://radio.test/new',
    },
  );
  expect(operations.diagnostics).toHaveBeenCalledTimes(1);
});

it('stops readiness polling after Stop while a native load is pending', async () => {
  const { players, operations } = setup();
  const load = deferred<string>();
  vi.mocked(operations.command).mockImplementationOnce(() => load.promise);
  const old = players.loadRadio('https://radio.test/old');
  const cancelled = old.catch((error: unknown) => error);
  await Promise.resolve();
  expect(operations.command).toHaveBeenCalledWith('LoadRadioStation', {
    url: 'https://radio.test/old',
  });
  await players.stopRadio();
  load.resolve('');
  expect(await cancelled).toEqual(new Error('Radio loading cancelled'));

  expect(operations.diagnostics).not.toHaveBeenCalled();
});

it('does not let stale readiness from an older load satisfy a new radio selection', async () => {
  const { players, operations } = setup();
  const read = deferred<Record<string, string>>();
  vi.mocked(operations.diagnostics).mockReturnValueOnce(read.promise);
  const old = players.loadRadio('https://radio.test/old');
  const cancelled = old.catch((error: unknown) => error);
  await Promise.resolve();
  await Promise.resolve();
  expect(operations.diagnostics).toHaveBeenCalledTimes(1);
  await players.loadRadio('https://radio.test/new');
  read.resolve({ RadioState: '2' });
  expect(await cancelled).toEqual(new Error('Radio loading cancelled'));

  expect(operations.diagnostics).toHaveBeenCalledTimes(2);
});

it('does not repeat full diagnostic reads after a stopped loading station', async () => {
  vi.useFakeTimers();
  const { players, operations } = setup();
  vi.mocked(operations.diagnostics).mockResolvedValueOnce({ RadioState: '1' });
  const old = players.loadRadio('https://radio.test/old');
  const cancelled = old.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  expect(operations.diagnostics).toHaveBeenCalledTimes(1);
  await players.stopRadio();
  await vi.advanceTimersByTimeAsync(100);
  expect(await cancelled).toEqual(new Error('Radio loading cancelled'));

  expect(operations.diagnostics).toHaveBeenCalledTimes(1);
});
