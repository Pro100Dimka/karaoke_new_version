import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EnvironmentSettingDto } from '../../../../../contracts/models';
import { pythonClient } from '../../../../../services/pythonClient';
import { useEnvironmentSettings } from './useEnvironmentSettings';

const notify = vi.hoisted(() => vi.fn());
vi.mock('../../../../../providers/notifications', () => ({
  useNotify: () => notify,
}));
vi.mock('../../../../../services/pythonClient', () => ({
  pythonClient: {
    listEnvironmentSettings: vi.fn(),
    updateEnvironmentSetting: vi.fn(),
    verifyEnvironmentSetting: vi.fn(),
  },
}));

const secret: EnvironmentSettingDto = {
  key: 'AD_VOICE_AUDD_TOKEN',
  group: 'recognition',
  kind: 'secret',
  value: '',
  configured: false,
  state: 'empty',
  message: 'Not configured',
};
const clients: QueryClient[] = [];
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(pythonClient.listEnvironmentSettings).mockResolvedValue([secret]);
  vi.mocked(pythonClient.verifyEnvironmentSetting).mockResolvedValue({
    ...secret,
    configured: true,
    state: 'valid',
  });
});
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

const openSettings = async () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(useEnvironmentSettings, { wrapper });
  await waitFor(() => expect(view.result.current.entries).toHaveLength(1));
  return { ...view, client };
};

it('keeps an unsaved secret after a write error and clears it only after a successful retry', async () => {
  vi.mocked(pythonClient.updateEnvironmentSetting)
    .mockRejectedValueOnce(new Error('Storage unavailable'))
    .mockResolvedValueOnce({
      ...secret,
      configured: true,
      state: 'unverified',
    });
  const { result, client } = await openSettings();
  await act(() => result.current.save(secret.key, 'synthetic-unsaved-key'));

  await waitFor(() =>
    expect(result.current.entries?.[0]).toMatchObject({
      value: 'synthetic-unsaved-key',
      state: 'invalid',
    }),
  );
  expect(result.current.json).toEqual({});
  expect(client.getQueryData(['environment-settings'])).toEqual([
    expect.objectContaining({ value: '' }),
  ]);
  expect(notify).not.toHaveBeenCalledWith(
    expect.stringContaining('synthetic-unsaved-key'),
    expect.anything(),
  );

  await act(() => result.current.save(secret.key, 'synthetic-unsaved-key'));
  await waitFor(() =>
    expect(result.current.entries?.[0]).toMatchObject({
      value: '',
      configured: true,
      state: 'valid',
    }),
  );
  expect(result.current.json).toEqual({});
});

it('allows clearing a rejected secret without removing a previously stored key', async () => {
  vi.mocked(pythonClient.listEnvironmentSettings).mockResolvedValue([
    { ...secret, configured: true, state: 'valid' },
  ]);
  vi.mocked(pythonClient.updateEnvironmentSetting).mockRejectedValue(
    new Error('Storage unavailable'),
  );
  const { result } = await openSettings();
  await act(() => result.current.save(secret.key, 'synthetic-rejected-key'));
  await waitFor(() =>
    expect(result.current.entries?.[0]?.value).toBe('synthetic-rejected-key'),
  );

  act(() => result.current.change(secret.key, ''));
  expect(result.current.entries?.[0]?.value).toBe('');
  expect(result.current.entries?.[0]?.configured).toBe(true);
  expect(pythonClient.updateEnvironmentSetting).toHaveBeenCalledTimes(1);
});

it('does not restore an older failed secret after the user clears its pending replacement', async () => {
  let rejectWrite: (reason: Error) => void = () => {};
  vi.mocked(pythonClient.updateEnvironmentSetting).mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectWrite = reject;
      }),
  );
  const { result } = await openSettings();
  let saving: Promise<void> = Promise.resolve();
  act(() => {
    saving = result.current.save(secret.key, 'synthetic-old-key');
  });
  await waitFor(() =>
    expect(pythonClient.updateEnvironmentSetting).toHaveBeenCalledOnce(),
  );
  act(() => result.current.change(secret.key, ''));
  await act(async () => {
    rejectWrite(new Error('Storage unavailable'));
    await saving;
  });

  await waitFor(() =>
    expect(result.current.entries?.[0]?.state).toBe('invalid'),
  );
  expect(result.current.entries?.[0]?.value).toBe('');
  expect(result.current.json).toEqual({});
});
