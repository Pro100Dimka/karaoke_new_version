import { afterEach, expect, it, vi } from 'vitest';
import type { SettingsBackendPort } from '../../../../../application/settings/SettingsPorts';
import type {
  EnvironmentSettingDto,
  KaggleActionDto,
} from '../../../../../contracts/models';
import { environmentStoreFor } from './environmentStore';

const token: EnvironmentSettingDto = {
  key: 'KAGGLE_API_TOKEN',
  group: 'kaggle',
  kind: 'secret',
  value: '',
  configured: true,
  state: 'valid',
  message: '',
};
const success: KaggleActionDto = { state: 'valid', message: 'Deployed' };
const backend = () => ({
  listEnvironmentSettings: vi
    .fn<SettingsBackendPort['listEnvironmentSettings']>()
    .mockResolvedValue([token]),
  updateEnvironmentSetting: vi
    .fn<SettingsBackendPort['updateEnvironmentSetting']>()
    .mockResolvedValue(token),
  verifyEnvironmentSetting: vi
    .fn<SettingsBackendPort['verifyEnvironmentSetting']>()
    .mockResolvedValue(token),
  verifyKaggleSettings: vi
    .fn<SettingsBackendPort['verifyKaggleSettings']>()
    .mockResolvedValue(success),
  loginKaggle: vi
    .fn<SettingsBackendPort['loginKaggle']>()
    .mockResolvedValue(success),
  deployKaggle: vi
    .fn<SettingsBackendPort['deployKaggle']>()
    .mockResolvedValue(success),
  getAiProcessingSettings: vi
    .fn<SettingsBackendPort['getAiProcessingSettings']>()
    .mockResolvedValue({ processingBackend: 'Local', kaggleConfigured: false }),
});
const deferred = () => {
  let resolve = (_value: KaggleActionDto) => {};
  const promise = new Promise<KaggleActionDto>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

afterEach(() => vi.restoreAllMocks());

it('requests notebook recovery only when explicitly selected', async () => {
  const api = backend();
  const store = environmentStoreFor(api);
  await store.load();
  await store.runKaggleAction('deploy', true);
  expect(api.deployKaggle).toHaveBeenCalledExactlyOnceWith(true);
});

it('keeps one deployment and its start time when the settings view closes and reopens', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const api = backend();
  const deployment = deferred();
  api.deployKaggle.mockReturnValueOnce(deployment.promise);
  const store = environmentStoreFor(api);
  const close = store.subscribe(vi.fn());
  await store.load();

  const running = store.runKaggleAction('deploy');
  expect(store.runKaggleAction('login')).toBe(running);
  await vi.waitFor(() => expect(api.deployKaggle).toHaveBeenCalledOnce());
  expect(store.getSnapshot()).toMatchObject({
    kaggleAction: 'deploy',
    kaggleStartedAt: 1000,
  });
  close();

  now.mockReturnValue(5000);
  const reopened = environmentStoreFor(api);
  const changes = vi.fn();
  const closeAgain = reopened.subscribe(changes);
  expect(reopened).toBe(store);
  await reopened.load();
  expect(reopened.runKaggleAction('deploy')).toBe(running);
  expect(reopened.getSnapshot().kaggleStartedAt).toBe(1000);
  expect(api.listEnvironmentSettings).toHaveBeenCalledOnce();
  expect(api.deployKaggle).toHaveBeenCalledOnce();

  deployment.resolve(success);
  await expect(running).resolves.toBe('Deployed');
  expect(api.verifyKaggleSettings).toHaveBeenCalledOnce();
  expect(changes).toHaveBeenCalled();
  expect(reopened.getSnapshot()).toMatchObject({
    kaggleAction: null,
    kaggleStartedAt: null,
  });
  closeAgain();
});

it('waits for login before starting deployment and measuring its duration', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(2000);
  const api = backend();
  const login = deferred();
  const deployment = deferred();
  api.loginKaggle.mockReturnValueOnce(login.promise);
  api.deployKaggle.mockReturnValueOnce(deployment.promise);
  const store = environmentStoreFor(api);
  await store.load();

  const running = store.runKaggleAction('login');
  await vi.waitFor(() => expect(api.loginKaggle).toHaveBeenCalledOnce());
  expect(api.deployKaggle).not.toHaveBeenCalled();
  expect(store.getSnapshot()).toMatchObject({
    kaggleAction: 'login',
    kaggleStartedAt: null,
  });
  expect(store.runKaggleAction('deploy')).toBe(running);

  login.resolve(success);
  await vi.waitFor(() => expect(api.deployKaggle).toHaveBeenCalledOnce());
  expect(store.getSnapshot()).toMatchObject({
    kaggleAction: 'deploy',
    kaggleStartedAt: 2000,
  });
  deployment.resolve(success);
  await expect(running).resolves.toBe('Deployed');
  expect(store.getSnapshot().kaggleAction).toBeNull();
});

it('preserves the backend deployment error instead of replacing it with a generic field error', async () => {
  const api = backend();
  const error = {
    code: 'KaggleGpuSessionLimit',
    message: 'Both GPU sessions are in use',
    source: 'python',
  };
  api.deployKaggle.mockRejectedValueOnce(error);
  const store = environmentStoreFor(api);
  await store.load();
  await expect(store.runKaggleAction('deploy')).rejects.toEqual(error);
  expect(store.getSnapshot().entries?.[0]?.errorMessage).toBe(error.message);
});

it.each(['loginKaggle', 'deployKaggle', 'verifyKaggleSettings'] as const)(
  'clears a failed %s operation and allows a new attempt',
  async (method) => {
    const api = backend();
    api[method].mockRejectedValueOnce(new Error('Unavailable'));
    const store = environmentStoreFor(api);
    await store.load();

    await expect(store.runKaggleAction('login')).rejects.toThrow('Unavailable');
    expect(store.getSnapshot()).toMatchObject({
      kaggleAction: null,
      kaggleStartedAt: null,
      entries: [
        expect.objectContaining({
          state: 'invalid',
          errorMessage: 'Unavailable',
        }),
      ],
    });
    await expect(store.runKaggleAction('login')).resolves.toBe('Deployed');
    expect(store.getSnapshot()).toMatchObject({
      kaggleAction: null,
      kaggleStartedAt: null,
      entries: [expect.objectContaining({ state: 'valid' })],
    });
  },
);
