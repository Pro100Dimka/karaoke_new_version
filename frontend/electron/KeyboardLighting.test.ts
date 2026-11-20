// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { OpenRgbKeyboardLighting } from './KeyboardLighting';

const listing = '0: Keyboard\n  Type: Keyboard\n';

it('keeps a delayed color update from turning the keyboard back on after Off', async () => {
  let finishFirst!: () => void;
  const applied: string[] = [];
  let writes = 0;
  const run = async (args: readonly string[]) => {
    if (args.includes('--list-devices')) return listing;
    if (++writes === 1)
      await new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
    const index = args.indexOf('--color');
    const color = args[index + 1];
    if (index < 0 || color === undefined)
      throw new Error('Missing color argument');
    applied.push(color);
    return '';
  };
  const provider = new OpenRgbKeyboardLighting('OpenRGB.exe', run);
  await provider.capabilities();
  const first = provider.apply({
    enabled: true,
    brightness: 70,
    color: 'FF0000',
  });
  await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'));
  const off = provider.apply({
    enabled: false,
    brightness: 70,
    color: 'FF0000',
  });
  finishFirst();
  await Promise.all([first, off]);

  expect(applied.at(-1)).toBe('000000');
});

it('applies the latest pending color instead of accumulating obsolete animation frames', async () => {
  let finishFirst!: () => void;
  const applied: string[] = [];
  let writes = 0;
  const run = async (args: readonly string[]) => {
    if (args.includes('--list-devices')) return listing;
    if (++writes === 1)
      await new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
    const index = args.indexOf('--color');
    const color = args[index + 1];
    if (index < 0 || color === undefined)
      throw new Error('Missing color argument');
    applied.push(color);
    return '';
  };
  const provider = new OpenRgbKeyboardLighting('OpenRGB.exe', run);
  await provider.capabilities();
  const first = provider.apply({
    enabled: true,
    brightness: 70,
    color: 'FF0000',
  });
  await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'));
  const pending = ['00FF00', '0000FF', 'FFFFFF'].map((color) =>
    provider.apply({ enabled: true, brightness: 70, color }),
  );
  finishFirst();
  await Promise.all([first, ...pending]);

  expect(applied).toEqual(['FF0000', 'FFFFFF']);
});

it('allows a later setting after an OpenRGB command fails', async () => {
  const run = vi.fn(async (args: readonly string[]) =>
    args.includes('--list-devices') ? listing : '',
  );
  const provider = new OpenRgbKeyboardLighting('OpenRGB.exe', run);
  await provider.capabilities();
  run.mockRejectedValueOnce(new Error('Device disconnected'));
  await expect(
    provider.apply({ enabled: true, brightness: 70, color: 'FF0000' }),
  ).rejects.toThrow('Device disconnected');
  await expect(
    provider.apply({ enabled: false, brightness: 70, color: 'FF0000' }),
  ).resolves.toBeUndefined();
  expect(run).toHaveBeenLastCalledWith(
    expect.arrayContaining(['--color', '000000']),
  );
});

it('does not relaunch OpenRGB for an unchanged normalized color and brightness', async () => {
  const run = vi.fn(async (args: readonly string[]) =>
    args.includes('--list-devices') ? listing : '',
  );
  const provider = new OpenRgbKeyboardLighting('OpenRGB.exe', run);
  await provider.capabilities();
  run.mockClear();
  for (let frame = 0; frame < 120; frame += 1)
    await provider.apply({
      enabled: true,
      brightness: frame % 2 ? 69.8 : 70.2,
      color: frame % 2 ? 'ff173d' : 'FF173D',
    });
  expect(run).toHaveBeenCalledOnce();

  await provider.apply({ enabled: true, brightness: 71, color: 'FF173D' });
  expect(run).toHaveBeenCalledTimes(2);
  await provider.apply({ enabled: true, brightness: 71, color: '35E39A' });
  expect(run).toHaveBeenCalledTimes(3);
});

it('reapplies an unchanged setting after explicit device discovery', async () => {
  const run = vi.fn(async (args: readonly string[]) =>
    args.includes('--list-devices') ? listing : '',
  );
  const provider = new OpenRgbKeyboardLighting('OpenRGB.exe', run);
  const setting = { enabled: true, brightness: 70, color: 'FF173D' };
  await provider.apply(setting);
  run.mockClear();
  await provider.capabilities();
  await provider.apply(setting);
  expect(run).toHaveBeenCalledTimes(2);
  expect(run).toHaveBeenLastCalledWith(
    expect.arrayContaining(['--color', 'FF173D']),
  );
});

it('retries the previous setting after a failed command that may have changed the device', async () => {
  const run = vi.fn(async (args: readonly string[]) =>
    args.includes('--list-devices') ? listing : '',
  );
  const provider = new OpenRgbKeyboardLighting('OpenRGB.exe', run);
  const setting = { enabled: true, brightness: 70, color: 'FF173D' };
  await provider.apply(setting);
  run.mockClear();
  run.mockRejectedValueOnce(new Error('Partial device update'));
  await expect(provider.apply({ ...setting, color: '35E39A' })).rejects.toThrow(
    'Partial device update',
  );
  await provider.apply(setting);
  expect(run).toHaveBeenCalledTimes(2);
});

it('preserves the latest off request after a duplicate arrives during an in-flight update', async () => {
  let finish!: () => void;
  const run = vi.fn(async (args: readonly string[]) => {
    if (args.includes('--list-devices')) return listing;
    if (!finish)
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    return '';
  });
  const provider = new OpenRgbKeyboardLighting('OpenRGB.exe', run);
  await provider.capabilities();
  run.mockClear();
  const setting = { enabled: true, brightness: 70, color: 'FF173D' };
  const first = provider.apply(setting);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  const duplicate = provider.apply(setting);
  const off = provider.apply({ ...setting, enabled: false });
  finish();
  await Promise.all([first, duplicate, off]);
  expect(run).toHaveBeenCalledTimes(2);
  expect(run).toHaveBeenLastCalledWith(
    expect.arrayContaining(['--color', '000000']),
  );
});
