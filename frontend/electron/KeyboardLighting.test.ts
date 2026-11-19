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
    applied.push(args[args.indexOf('--color') + 1]!);
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
    applied.push(args[args.indexOf('--color') + 1]!);
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
