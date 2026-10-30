import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PropsWithChildren } from 'react';
import type { AIModel } from '../../../../../utils/contracts';
import Models from './models';

const mocks = vi.hoisted(() => ({ request: vi.fn(), free: vi.fn(), cancel: vi.fn(), notify: vi.fn(), ask: vi.fn() }));
vi.mock('../../../../../services/desktopBridge', () => ({ bridgedHttp: mocks.request }));
vi.mock('../../../../../services/pythonClient', () => ({ pythonClient: { freeStorageBytes: mocks.free, cancelJob: mocks.cancel } }));
vi.mock('../../../../../providers/notifications', () => ({ useNotify: () => mocks.notify }));
vi.mock('../../../../../providers/dialog', () => ({ ask: mocks.ask }));
let client: QueryClient;
let model: AIModel;
const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
beforeEach(() => {
  vi.resetAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  model = { modelId: 'Test model', version: '1', purpose: 'ASR', state: 'Missing', size: 100, requiredDiskBytes: 200 };
  mocks.free.mockResolvedValue(1000);
  mocks.ask.mockResolvedValue('delete');
  mocks.cancel.mockResolvedValue(undefined);
  mocks.request.mockImplementation(async (_bridge, request) => {
    if (request.path === '/models') return [model];
    if (request.path.startsWith('/jobs')) return { items: [{ jobId: 'job', entityId: 'Test model:1',
      state: 'Running', stage: 'Download', stageProgress: 0.25, overallProgress: 0.2 }] };
    model = { ...model, state: request.method === 'DELETE' ? 'Missing' : 'Downloading' };
    return { jobId: 'job' };
  });
});
afterEach(() => { cleanup(); client.clear(); vi.useRealTimers(); });

it('continues the existing download after the panel is reopened without starting another job', async () => {
  model.state = 'Downloading';
  const first = render(<Models />, { wrapper });
  await waitFor(() => expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25'));
  first.unmount();
  render(<Models />, { wrapper });
  await waitFor(() => expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25'));
  expect(mocks.request.mock.calls.some(([, request]) => request.method === 'POST')).toBe(false);
});

it('deduplicates download clicks and keeps the pending action locked across remount', async () => {
  let finish!: (value: unknown) => void;
  const defaultRequest = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation((bridge, request) => request.method === 'POST'
    ? new Promise(resolve => { finish = resolve; }) : defaultRequest(bridge, request));
  const first = render(<Models />, { wrapper });
  const button = await screen.findByRole('button', { name: 'modelDownload Test model' });
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(mocks.request.mock.calls.filter(([, request]) => request.method === 'POST')).toHaveLength(1));
  first.unmount();
  render(<Models />, { wrapper });
  expect(await screen.findByRole('button', { name: 'modelDownload Test model' })).toBeDisabled();
  await act(async () => { model.state = 'Downloading'; finish({ jobId: 'job' }); });
  await waitFor(() => expect(screen.getByRole('progressbar')).toBeInTheDocument());
});

it('keeps models visible when free-space discovery fails', async () => {
  mocks.free.mockRejectedValue(new Error('disk offline'));
  render(<Models />, { wrapper });
  expect(await screen.findByRole('button', { name: 'modelDownload Test model' })).toBeInTheDocument();
});

it('disables downloading when the model disk has insufficient space', async () => {
  mocks.free.mockResolvedValue(10);
  render(<Models />, { wrapper });
  await waitFor(() => expect(screen.getByRole('button', { name: 'modelDownload Test model' })).toBeDisabled());
  expect(mocks.free).toHaveBeenCalledWith('models');
});

it('reports cancellation failures and leaves the current job visible', async () => {
  model.state = 'Downloading';
  mocks.cancel.mockRejectedValue(new Error('cancel rejected'));
  render(<Models />, { wrapper });
  fireEvent.click(await screen.findByRole('button', { name: 'cancel' }));
  await waitFor(() => expect(mocks.notify).toHaveBeenCalledWith('cancel rejected', 'error'));
  expect(screen.getByRole('progressbar')).toBeInTheDocument();
});

it('allows retrying a rejected download without leaving the action locked', async () => {
  const defaultRequest = mocks.request.getMockImplementation()!;
  let failed = false;
  mocks.request.mockImplementation((bridge, request) => {
    if (request.method === 'POST' && !failed) { failed = true; throw new Error('download rejected'); }
    return defaultRequest(bridge, request);
  });
  render(<Models />, { wrapper });
  fireEvent.click(await screen.findByRole('button', { name: 'modelDownload Test model' }));
  await waitFor(() => expect(mocks.notify).toHaveBeenCalledWith('download rejected', 'error'));
  await waitFor(() => expect(screen.getByRole('button', { name: 'modelDownload Test model' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'modelDownload Test model' }));
  await waitFor(() => expect(screen.getByRole('progressbar')).toBeInTheDocument());
});

it('requires confirmation before deleting a ready model', async () => {
  model.state = 'Ready';
  mocks.ask.mockResolvedValue('cancel');
  render(<Models />, { wrapper });
  fireEvent.click(await screen.findByRole('button', { name: 'modelDelete Test model' }));
  await waitFor(() => expect(mocks.ask).toHaveBeenCalledOnce());
  expect(mocks.request.mock.calls.some(([, request]) => request.method === 'DELETE')).toBe(false);
});

it('shows the finished model even when the last cached job still says running', async () => {
  model.state = 'Downloading';
  render(<Models />, { wrapper });
  await screen.findByRole('progressbar');
  await act(async () => {
    model = { ...model, state: 'Ready' };
    await client.invalidateQueries({ queryKey: ['models'] });
  });
  expect(await screen.findByRole('button', { name: 'modelDelete Test model' })).toBeEnabled();
  expect(screen.queryByRole('progressbar')).toBeNull();
});

it.each([1, 3])('keeps the same download after %s failed progress reads and recovers on retry', async (failures) => {
  model.state = 'Downloading';
  render(<Models />, { wrapper });
  await screen.findByRole('progressbar');
  const defaultRequest = mocks.request.getMockImplementation()!;
  let remaining = failures;
  mocks.request.mockImplementation((bridge, request) => {
    if (request.path.startsWith('/jobs') && remaining-- > 0) throw new Error('progress offline');
    return defaultRequest(bridge, request);
  });
  for (let index = 0; index < failures; index++) {
    await act(async () => { await client.invalidateQueries({ queryKey: ['job'] }); });
  }
  expect(await screen.findByRole('button', { name: 'cancel' })).toBeInTheDocument();
  fireEvent.click(await screen.findByRole('button', { name: 'retry' }));
  await waitFor(() => expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25'));
  expect(mocks.request.mock.calls.some(([, request]) => request.method === 'POST')).toBe(false);
});

it('polls externally started downloads only while the panel is mounted', async () => {
  vi.useFakeTimers();
  model.state = 'Downloading';
  const view = render(<Models />, { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  const before = mocks.request.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(mocks.request.mock.calls.length).toBeGreaterThan(before);
  view.unmount();
  const closed = mocks.request.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(mocks.request.mock.calls).toHaveLength(closed);
});
