import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPeaksService } from './PeaksService';

const roots: string[] = [];
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const source = async () => {
  const root = await mkdtemp(join(tmpdir(), 'peaks-cancel-'));
  roots.push(root);
  const file = join(root, 'take.wav');
  await writeFile(file, 'audio');
  return file;
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it('does not start a waveform read that was already abandoned', async () => {
  const compute = vi.fn(async () => [1]);
  const peaks = createPeaksService(compute);
  const controller = new AbortController();
  controller.abort();
  await expect(
    peaks(await source(), 240, controller.signal),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(compute).not.toHaveBeenCalled();
});

it('cancels one preview promptly while a sibling still owns their shared read', async () => {
  const file = await source();
  const held = deferred<number[]>();
  const compute = vi.fn(
    (_path: string, _bins: number, _signal?: AbortSignal) => held.promise,
  );
  const peaks = createPeaksService(compute);
  const first = new AbortController();
  const second = new AbortController();
  const firstResult = peaks(file, 240, first.signal).catch(
    (error: unknown) => error,
  );
  const secondResult = peaks(file, 240, second.signal);
  await vi.waitFor(() => expect(compute).toHaveBeenCalledOnce());
  first.abort();
  let cancelled = false;
  void firstResult.then((error) => {
    cancelled = (error as Error).name === 'AbortError';
  });
  try {
    await vi.waitFor(() => expect(cancelled).toBe(true));
    expect(compute.mock.calls[0]?.[2]?.aborted).toBe(false);
  } finally {
    held.resolve([0.5, 1]);
  }
  await expect(secondResult).resolves.toEqual([0.5, 1]);
  await expect(peaks(file, 240)).resolves.toEqual([0.5, 1]);
  expect(compute).toHaveBeenCalledOnce();
});

it('stops the last abandoned reader without poisoning a fresh request for the same file', async () => {
  const file = await source();
  const oldRead = deferred<number[]>();
  const freshRead = deferred<number[]>();
  const compute = vi
    .fn(
      (_path: string, _bins: number, _signal?: AbortSignal) => oldRead.promise,
    )
    .mockImplementationOnce(() => oldRead.promise)
    .mockImplementationOnce(() => freshRead.promise);
  const peaks = createPeaksService(compute);
  const controller = new AbortController();
  const oldResult = peaks(file, 240, controller.signal).catch(
    (error: unknown) => error,
  );
  await vi.waitFor(() => expect(compute).toHaveBeenCalledOnce());
  const oldSignal = compute.mock.calls[0]?.[2];
  controller.abort();
  await expect(oldResult).resolves.toMatchObject({ name: 'AbortError' });
  expect(oldSignal?.aborted).toBe(true);
  const fresh = peaks(file, 240);
  await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(2));
  oldRead.reject(new Error('late cancelled read'));
  await oldResult;
  const sibling = peaks(file, 240);
  freshRead.resolve([1, 0.25]);
  await expect(fresh).resolves.toEqual([1, 0.25]);
  await expect(sibling).resolves.toEqual([1, 0.25]);
  expect(compute).toHaveBeenCalledTimes(2);
});
