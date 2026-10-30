import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { Form } from '@neo-ui-kit/react';
import type { PropsWithChildren } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import useSettingsForm from './form';
import AppearancePanel from './appearance';
import AIPanel from './ai';
import { store } from '../../../../providers/store';

const mocks = vi.hoisted(() => ({
  read: vi.fn(), save: vi.fn(), root: vi.fn(), notify: vi.fn(), pick: vi.fn(), setRoot: vi.fn(),
}));
vi.mock('../../../../services/pythonClient', () => ({ pythonClient: {
  getAiProcessingSettings: mocks.read, updateAiProcessingSettings: mocks.save,
} }));
vi.mock('../../../../services/desktopClient', () => ({ desktopClient: {
  getStorageRoot: mocks.root, pickStorageFolder: mocks.pick, setStorageRoot: mocks.setRoot,
} }));
vi.mock('./ai/models', () => ({ default: () => null }));
vi.mock('../../../../providers/notifications', () => ({ useNotify: () => mocks.notify }));
vi.mock('../../../../providers/radio', () => ({ useRadio: () => ({ canControl: true }) }));
vi.mock('../../../../providers/social', () => ({
  useSocial: () => ({ type: 'offline' }), useSocialDirectory: () => ({}),
}));
vi.mock('../../../../features/social/usePersonPhoto', () => ({ usePersonPhoto: () => undefined }));
vi.mock('./appearance/keyboardlighting/useKeyboardLighting', () => ({ useKeyboardLighting: () => ({}) }));
vi.mock('./audio/useAudioSettings', () => ({ useAudioSettings: () => ({ audio: {
  audioAvailable: false, values: { backend: 'ASIO' }, capabilities: { microphone: 'unavailable' },
} }) }));
vi.mock('./audio/useInputMonitoring', () => ({ useInputMonitoring: () => ({ setTestingInput: vi.fn() }) }));

let client: QueryClient;
const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
beforeEach(() => {
  vi.resetAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  mocks.read.mockResolvedValue({ processingBackend: 'Local' });
  mocks.save.mockResolvedValue({ processingBackend: 'Kaggle' });
  mocks.root.mockResolvedValue('E:/library');
  mocks.pick.mockResolvedValue('E:/new-library');
  mocks.setRoot.mockResolvedValue(undefined);
});

const ProcessingPanel = () => {
  const form = useSettingsForm('ai');
  return <Form form={form}><AIPanel form={form} language="ru" /></Form>;
};

it('keeps the saved folder when selecting another folder fails to persist', async () => {
  mocks.setRoot.mockRejectedValue(new Error('folder rejected'));
  render(<ProcessingPanel />, { wrapper });
  await screen.findByDisplayValue('E:/library');
  fireEvent.click(screen.getByRole('button', { name: 'selectFolder' }));
  await waitFor(() => expect(mocks.notify).toHaveBeenCalledWith('folder rejected', 'error'));
  expect(screen.getByDisplayValue('E:/library')).toBeInTheDocument();
});

it('loads the saved folder when the picker is cancelled during initial loading', async () => {
  const initial = deferred<string>();
  mocks.root.mockReturnValueOnce(initial.promise);
  mocks.pick.mockResolvedValue(null);
  render(<ProcessingPanel />, { wrapper });
  fireEvent.click(screen.getByRole('button', { name: 'selectFolder' }));
  await waitFor(() => expect(mocks.pick).toHaveBeenCalledOnce());
  await act(async () => { initial.resolve('E:/library'); });
  expect(await screen.findByDisplayValue('E:/library')).toBeInTheDocument();
  expect(mocks.setRoot).not.toHaveBeenCalled();
});

it('keeps a successful backend change when an older settings read finishes', async () => {
  const initial = deferred<{ processingBackend: string }>();
  mocks.read.mockReturnValueOnce(initial.promise);
  const { result } = renderHook(() => useSettingsForm('ai'), { wrapper });
  act(() => result.current.setValue('ai.backend', 'Kaggle'));
  await waitFor(() => expect(result.current.values.ai.backend).toBe('Kaggle'));
  await act(async () => { initial.resolve({ processingBackend: 'Local' }); });
  expect(client.getQueryData(['processing-settings'])).toEqual({ processingBackend: 'Kaggle' });
});

it('keeps the backend save locked across closing and reopening settings', async () => {
  const pending = deferred<{ processingBackend: string }>();
  mocks.save.mockReturnValueOnce(pending.promise);
  const first = renderHook(() => useSettingsForm('ai'), { wrapper });
  await waitFor(() => expect(first.result.current.values.ai.savingBackend).toBe(false));
  act(() => first.result.current.setValue('ai.backend', 'Kaggle'));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
  first.unmount();
  const second = renderHook(() => useSettingsForm('ai'), { wrapper });
  expect(second.result.current.values.ai.savingBackend).toBe(true);
  act(() => second.result.current.setValue('ai.backend', 'Local'));
  expect(mocks.save).toHaveBeenCalledTimes(1);
  await act(async () => { pending.resolve({ processingBackend: 'Kaggle' }); });
  await waitFor(() => expect(second.result.current.values.ai.backend).toBe('Kaggle'));
});

it('keeps the saved library folder when an older read completes', async () => {
  const initial = deferred<string>();
  mocks.root.mockReturnValueOnce(initial.promise);
  const { result } = renderHook(() => useSettingsForm('ai'), { wrapper });
  act(() => result.current.setValue('ai.transferToLibraryPath', 'E:/new-library'));
  await act(async () => { initial.resolve('E:/old-library'); });
  expect(client.getQueryData(['storage-root'])).toBe('E:/new-library');
});

it('reloads authoritative settings after a rejected backend write', async () => {
  mocks.save.mockRejectedValue(new Error('write rejected'));
  const { result } = renderHook(() => useSettingsForm('ai'), { wrapper });
  await waitFor(() => expect(result.current.values.ai.savingBackend).toBe(false));
  mocks.read.mockResolvedValue({ processingBackend: 'Kaggle' });
  act(() => result.current.setValue('ai.backend', 'Local'));
  await waitFor(() => expect(mocks.notify).toHaveBeenCalledWith('write rejected', 'error'));
  await waitFor(() => expect(result.current.values.ai.backend).toBe('Kaggle'));
});

it('shows the saved profile photo when the new settings panel opens again', async () => {
  const photo = 'data:image/webp;base64,bG9jYWw=';
  store.updatePreferences({ profilePhoto: photo, displayName: 'FIRE PEPPER' });
  const Panel = () => {
    const form = useSettingsForm('appearance');
    return <Form form={form}><AppearancePanel form={form} language="ru" /></Form>;
  };
  const first = render(<Panel />, { wrapper });
  await waitFor(() => expect(first.container.innerHTML).toContain(photo));
  first.unmount();
  const second = render(<Panel />, { wrapper });
  await waitFor(() => expect(second.container.innerHTML).toContain(photo));
});
