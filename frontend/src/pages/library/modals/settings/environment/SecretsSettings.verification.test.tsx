import { tr } from '@neo-ui-kit/react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EnvironmentSettingDto } from '../../../../../contracts/models';
import '../../../../../providers/localization';
import { SecretsSettings } from './index';

const api = vi.hoisted(() => ({
  listEnvironmentSettings: vi.fn(),
  updateEnvironmentSetting: vi.fn(),
  verifyEnvironmentSetting: vi.fn(),
  notify: vi.fn(),
}));
vi.mock('../../../../../services/pythonClient', () => ({ pythonClient: api }));
vi.mock('../../../../../providers/notifications', () => ({
  useNotify: () => api.notify,
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
const stored = (entry = secret): EnvironmentSettingDto => ({
  ...entry,
  value: '',
  configured: true,
  state: 'unverified',
  message: 'Saved',
});
const verifications: {
  key: string;
  resolve(value: EnvironmentSettingDto): void;
}[] = [];
const clients: QueryClient[] = [];

beforeEach(() => {
  vi.resetAllMocks();
  verifications.length = 0;
  api.listEnvironmentSettings.mockResolvedValue([secret]);
  api.updateEnvironmentSetting.mockImplementation(async () => stored());
  api.verifyEnvironmentSetting.mockImplementation(
    (key: string) =>
      new Promise<EnvironmentSettingDto>((resolve) => {
        verifications.push({ key, resolve });
      }),
  );
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

const openSettings = async (existing?: QueryClient) => {
  const client =
    existing ??
    new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { retry: false },
      },
    });
  if (!existing) clients.push(client);
  const view = render(
    <QueryClientProvider client={client}>
      <SecretsSettings />
    </QueryClientProvider>,
  );
  await screen.findByLabelText(tr('environmentFieldAuddToken'));
  return { ...view, client };
};
const input = () => screen.getByLabelText(tr('environmentFieldAuddToken'));
const status = () =>
  input()
    .closest('.environmentField')
    ?.querySelector('.environmentStatus')
    ?.getAttribute('data-state');
const replaceSecret = async (value: string, call: number) => {
  fireEvent.change(input(), { target: { value } });
  await waitFor(() =>
    expect(api.updateEnvironmentSetting).toHaveBeenNthCalledWith(
      call,
      secret.key,
      value,
    ),
  );
  await waitFor(() => expect(verifications).toHaveLength(call));
};
const finish = async (
  index: number,
  state: 'valid' | 'invalid',
  entry = secret,
) => {
  const verification = verifications[index];
  if (!verification)
    throw new Error(`Expected verification ${index + 1} has not started`);
  await act(async () => {
    verification.resolve({ ...stored(entry), state });
  });
};

it.each([
  { old: 'invalid', latest: 'valid', first: 'old' },
  { old: 'valid', latest: 'invalid', first: 'old' },
  { old: 'invalid', latest: 'valid', first: 'latest' },
  { old: 'valid', latest: 'invalid', first: 'latest' },
] as const)(
  'shows the latest $latest key result when the old result is $old and $first completes first',
  async ({ old, latest, first }) => {
    const { client } = await openSettings();
    await replaceSecret('synthetic-first-key', 1);
    await replaceSecret('synthetic-replacement-key', 2);

    if (first === 'old') {
      await finish(0, old);
      await finish(1, latest);
    } else {
      await finish(1, latest);
      await finish(0, old);
    }

    await waitFor(() => expect(status()).toBe(latest));
    expect(input()).toHaveValue('');
    expect(client.getQueryData(['environment-settings'])).toEqual([
      expect.objectContaining({ value: '', configured: true, state: latest }),
    ]);
    expect(api.notify).not.toHaveBeenCalled();
    expect(api.updateEnvironmentSetting).toHaveBeenCalledTimes(2);
  },
);

it('ignores an old key verification after closing and reopening the settings panel', async () => {
  const first = await openSettings();
  await replaceSecret('synthetic-first-key', 1);
  first.unmount();
  await openSettings(first.client);
  await replaceSecret('synthetic-replacement-key', 2);

  await finish(0, 'invalid');
  await finish(1, 'valid');

  await waitFor(() => expect(status()).toBe('valid'));
  expect(input()).toHaveValue('');
  expect(api.updateEnvironmentSetting).toHaveBeenCalledTimes(2);
});

it('keeps another field verification valid while a different secret is saved', async () => {
  const other: EnvironmentSettingDto = {
    ...secret,
    key: 'AD_VOICE_PROCESSING_TOKEN',
    group: 'processing',
  };
  api.listEnvironmentSettings.mockResolvedValue([secret, other]);
  api.updateEnvironmentSetting.mockImplementation(async (key: string) =>
    stored(key === secret.key ? secret : other),
  );
  const { client } = await openSettings();
  await replaceSecret('synthetic-audd-key', 1);
  fireEvent.change(
    screen.getByLabelText(tr('environmentFieldProcessingToken')),
    {
      target: { value: 'synthetic-processing-key' },
    },
  );
  await waitFor(() => expect(verifications).toHaveLength(2));
  await finish(0, 'valid');
  await finish(1, 'valid', other);

  await waitFor(() => expect(client.isMutating()).toBe(0));
  expect(status()).toBe('valid');
  expect(client.getQueryData(['environment-settings'])).toEqual([
    expect.objectContaining({ key: secret.key, value: '', state: 'valid' }),
    expect.objectContaining({ key: other.key, value: '', state: 'valid' }),
  ]);
});
