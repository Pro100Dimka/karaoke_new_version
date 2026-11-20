import { act, renderHook } from '@testing-library/react';
import { setLocale, tr } from '@neo-ui-kit/react';
import { beforeEach, expect, it, vi } from 'vitest';
import '../../../../../../providers/localization';
import { pythonClient } from '../../../../../../services/pythonClient';
import { useStorageCleanup } from './useStorageCleanup';

const ui = vi.hoisted(() => ({ ask: vi.fn(), notify: vi.fn() }));
vi.mock('../../../../../../providers/dialog', () => ({ ask: ui.ask }));
vi.mock('../../../../../../providers/notifications', () => ({
  useNotify: () => ui.notify,
}));
vi.mock('../../../../../../services/pythonClient', () => ({
  pythonClient: { clearCache: vi.fn(), clearTemporaryFiles: vi.fn() },
}));

beforeEach(() => {
  vi.resetAllMocks();
  ui.ask.mockResolvedValue('confirm');
});

const languages = [
  [
    'ru',
    'Дождитесь завершения фоновых задач перед очисткой кэша или временных файлов.',
  ],
  [
    'uk',
    'Дочекайтеся завершення фонових завдань перед очищенням кешу або тимчасових файлів.',
  ],
  [
    'en',
    'Wait for background jobs to finish before clearing cache or temporary files.',
  ],
] as const;

for (const kind of ['cache', 'temp'] as const)
  it.each(languages)(
    `explains an active-job ${kind} cleanup refusal in %s and permits a later retry`,
    async (language, message) => {
      setLocale(language);
      const request = vi.mocked(
        kind === 'cache'
          ? pythonClient.clearCache
          : pythonClient.clearTemporaryFiles,
      );
      request
        .mockRejectedValueOnce({
          code: 'StorageInUse',
          message:
            'Wait for background jobs to finish before clearing cached or temporary files',
        })
        .mockResolvedValueOnce(3);
      const changed = vi.fn();
      const { result } = renderHook(() => useStorageCleanup(changed));

      await act(() => result.current.clean(kind));
      expect(ui.notify).toHaveBeenCalledExactlyOnceWith(message, 'error');
      expect(result.current.cleaning).toBeNull();
      expect(changed).not.toHaveBeenCalled();

      await act(() => result.current.clean(kind));
      expect(request).toHaveBeenCalledTimes(2);
      expect(changed).toHaveBeenCalledOnce();
      expect(ui.notify).toHaveBeenLastCalledWith(tr('cleanupDone'), 'success');
      expect(result.current.cleaning).toBeNull();
    },
  );

it('reports unavailable storage without exposing backend paths', async () => {
  setLocale('en');
  vi.mocked(pythonClient.clearCache).mockRejectedValue({
    code: 'StorageUnavailable',
    message: 'Cannot remove /private/test-cache',
    details: { path: '/private/test-cache', removed: 0 },
  });
  const { result } = renderHook(() => useStorageCleanup(vi.fn()));
  await act(() => result.current.clean('cache'));
  expect(ui.notify).toHaveBeenCalledExactlyOnceWith(
    'Storage is unavailable.',
    'error',
  );
});

it('retains the generic cleanup error for unknown failures', async () => {
  setLocale('en');
  vi.mocked(pythonClient.clearTemporaryFiles).mockRejectedValue(
    new Error('Unexpected /private/test-cache error'),
  );
  const { result } = renderHook(() => useStorageCleanup(vi.fn()));
  await act(() => result.current.clean('temp'));
  expect(ui.notify).toHaveBeenCalledExactlyOnceWith('Cleanup failed', 'error');
});
