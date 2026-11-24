import { afterEach, describe, expect, it, vi } from 'vitest';
import { installBridge } from './audioClientFixture';
import { currentSampleRate, waitForReady } from './audioSession';

afterEach(() => {
  Reflect.deleteProperty(window, 'desktop');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('compact loading observations', () => {
  it('loads through progress snapshots while the full diagnostics endpoint is unavailable', async () => {
    vi.useFakeTimers();
    const started = performance.now();
    const { commands } = installBridge(({ command }) => {
      if (command !== 'GetPlaybackSnapshot')
        return { status: 1, text: 'Full diagnostics unavailable' };
      const elapsed = performance.now() - started;
      return {
        status: 0,
        text: `PlaybackState: ${elapsed >= 20_000 ? 2 : 1}\nPlaybackLoadProgressFrames: ${Math.floor(elapsed / 1000) * 48000}`,
      };
    });
    const result = waitForReady().then(
      () => 'ready',
      (error: Error) => error.message,
    );

    await vi.advanceTimersByTimeAsync(20_000);

    expect(await result).toBe('ready');
    expect(commands.every((command) => command === 'GetPlaybackSnapshot')).toBe(
      true,
    );
  });

  it.each([
    {
      text: 'RuntimeOutputSampleRate: 44100\nRequestedSampleRate: 48000',
      expected: 44100,
    },
    { text: 'RequestedSampleRate: 48000', expected: 48000 },
  ])(
    'reads the effective sample rate from a compact snapshot: $expected',
    async ({ text, expected }) => {
      const { commands } = installBridge(({ command }) =>
        command === 'GetPlaybackSnapshot'
          ? { status: 0, text }
          : { status: 1, text: 'Full diagnostics unavailable' },
      );

      await expect(currentSampleRate()).resolves.toBe(expected);
      expect(commands).toEqual(['GetPlaybackSnapshot']);
    },
  );
});
