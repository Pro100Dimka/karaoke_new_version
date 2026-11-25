import { expect, it, vi } from 'vitest';
import { mocks, contents, window } from '../test-fixtures/electronMain';

it('waits for accepted asynchronous log writes before the final quit', async () => {
  vi.resetModules();
  window.removeAllListeners();
  contents.removeAllListeners();
  mocks.stopService.mockResolvedValue(undefined);
  mocks.quit.mockClear();
  await import('./main');
  await mocks.ready.run();
  window.emit('closed');
  let finish!: () => void;
  mocks.stopLogs.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  vi.useFakeTimers();
  try {
    mocks.appEvents.get('before-quit')?.({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(1600);
    expect(mocks.quit).not.toHaveBeenCalled();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.quit).toHaveBeenCalledOnce();
  } finally {
    finish();
    vi.useRealTimers();
  }
});
