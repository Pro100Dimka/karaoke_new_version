import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useGuardedAction } from './useGuardedAction';
import { pythonClient } from '../../../services/pythonClient';
import { installBridge } from '../../../services/pythonClientFixture';

const notify = vi.hoisted(() => vi.fn());
vi.mock('../../../providers/notifications', () => ({
  useNotify: () => notify,
}));
vi.mock('@neo-ui-kit/react', () => ({
  tr: (key: string) => key,
  useLocale: () => 'ru',
}));
afterEach(() => {
  vi.clearAllMocks();
  Reflect.deleteProperty(window, 'desktop');
});

it('shows the specific master failure from a completed backend job', async () => {
  installBridge((call) => ({
    status: 200,
    ok: true,
    body:
      call.method === 'POST'
        ? { jobId: 'master', state: 'Queued' }
        : {
            jobId: 'master',
            state: 'Failed',
            error: {
              code: 'StudioMasterTimelineUnavailable',
              message: 'Recording timeline is invalid',
            },
          },
  }));
  const { result } = renderHook(useGuardedAction);
  await act(() =>
    result.current(async () => {
      await pythonClient.createStudioMaster('take');
    }, 'studioMasterFailed'),
  );
  expect(notify).toHaveBeenCalledExactlyOnceWith(
    'studioMasterTimelineUnavailable',
    'error',
  );
});

it('retains an unfamiliar backend explanation beside the operation name', async () => {
  const { result } = renderHook(useGuardedAction);
  await act(() =>
    result.current(async () => {
      throw {
        code: 'FutureMasterFailure',
        message: 'The source track cannot be read',
        source: 'python',
      };
    }, 'studioMasterFailed'),
  );
  expect(notify).toHaveBeenCalledExactlyOnceWith(
    'studioMasterFailed: The source track cannot be read',
    'error',
  );
});

it('keeps the localized fallback for unstructured failures', async () => {
  const { result } = renderHook(useGuardedAction);
  await act(() =>
    result.current(async () => {
      throw new Error('Internal detail');
    }),
  );
  expect(notify).toHaveBeenCalledExactlyOnceWith('actionFailed', 'error');
});
