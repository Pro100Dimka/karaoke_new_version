// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { OpenRgbKeyboardLighting } from './KeyboardLighting';

const listing = '0: Keyboard\n  Type: Keyboard\n';
const setting = { enabled: true, brightness: 70, color: 'FF0000' };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

it('does not apply a superseded color after slow automatic device discovery', async () => {
  const discovery = deferred<string>();
  const started = deferred<void>();
  const run = vi.fn(async (args: readonly string[]) => {
    if (args.includes('--list-devices')) {
      started.resolve();
      return discovery.promise;
    }
    return '';
  });
  const provider = new OpenRgbKeyboardLighting('OpenRGB.exe', run);
  const first = provider.apply(setting);
  await started.promise;
  const off = provider.apply({ ...setting, enabled: false });
  discovery.resolve(listing);
  await Promise.all([first, off]);
  expect(run).toHaveBeenCalledTimes(2);
  expect(run).toHaveBeenLastCalledWith(
    expect.arrayContaining(['--color', '000000']),
  );
});

it('shares in-flight device discovery while still checking again on the next explicit refresh', async () => {
  const discovery = deferred<string>();
  const run = vi.fn(async () => discovery.promise);
  const provider = new OpenRgbKeyboardLighting('OpenRGB.exe', run);
  const requests = Array.from({ length: 20 }, () => provider.capabilities());
  const count = run.mock.calls.length;
  discovery.resolve(listing);
  const values = await Promise.all(requests);
  expect(count).toBe(1);
  expect(
    values.every((value) => value.available && value.deviceCount === 1),
  ).toBe(true);
  await provider.capabilities();
  expect(run).toHaveBeenCalledTimes(2);
});

it('shares discovery requested by settings and the first pending color', async () => {
  const discovery = deferred<string>();
  const started = deferred<void>();
  const run = vi.fn(async (args: readonly string[]) => {
    if (args.includes('--list-devices')) {
      started.resolve();
      return discovery.promise;
    }
    return '';
  });
  const provider = new OpenRgbKeyboardLighting('OpenRGB.exe', run);
  const apply = provider.apply(setting);
  await started.promise;
  const capabilities = provider.capabilities();
  discovery.resolve(listing);
  await Promise.all([apply, capabilities]);
  expect(run).toHaveBeenCalledTimes(2);
});

it('retries discovery after a failure instead of retaining the failed attempt', async () => {
  const run = vi
    .fn()
    .mockRejectedValueOnce(new Error('Unavailable'))
    .mockResolvedValue(listing);
  const provider = new OpenRgbKeyboardLighting('OpenRGB.exe', run);
  await expect(provider.capabilities()).resolves.toMatchObject({
    available: false,
  });
  await expect(provider.capabilities()).resolves.toMatchObject({
    available: true,
  });
  expect(run).toHaveBeenCalledTimes(2);
});
