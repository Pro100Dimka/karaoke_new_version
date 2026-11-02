import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import type { PythonClient } from '../../../../../../contracts/clients';
import type { HistoryPageDto } from '../../../../../../contracts/models';
import { QueryProvider } from '../../../../../../test/QueryProvider';
import { historyKinds } from './historyModel';
import { useHistory } from './useHistory';

const backend = vi.hoisted(() => ({
  history: vi.fn<PythonClient['history']>(),
  listSongs: vi.fn<PythonClient['listSongs']>(),
}));
vi.mock('../../../../../../services/pythonClient', () => ({
  pythonClient: backend,
}));
const page = (id: string, total = 2): HistoryPageDto => ({
  items: [{ id, kind: 'RecordingRegistered', createdAt: '2026-01-01' }],
  total,
});
beforeEach(() => {
  vi.resetAllMocks();
  backend.listSongs.mockResolvedValue([]);
});

it('retains loaded pages after failure and retries history and titles independently', async () => {
  let finish = (_value: HistoryPageDto) => {};
  backend.history
    .mockResolvedValueOnce(page('first'))
    .mockRejectedValueOnce(new Error('Unavailable'))
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
  backend.listSongs.mockRejectedValueOnce(new Error('Unavailable'));
  const { result } = renderHook(useHistory, { wrapper: QueryProvider });
  await waitFor(() => expect(result.current.catalog.failed).toBe(true));
  expect(result.current.events.map(({ id }) => id)).toEqual(['first']);
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.catalog.titles).toEqual(new Map()));
  expect(backend.history).toHaveBeenCalledTimes(1);
  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.failed).toBe(true));
  expect(result.current.events.map(({ id }) => id)).toEqual(['first']);
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.loading).toBe(true));
  expect(result.current.failed).toBe(false);
  await act(async () => finish(page('second')));
  await waitFor(() => expect(result.current.events).toHaveLength(2));
  expect(result.current.failed).toBe(false);
  expect(result.current.total).toBe(2);
  expect(backend.listSongs).toHaveBeenCalledTimes(2);
  expect(backend.history.mock.calls).toEqual([
    [50, 0, historyKinds.performances],
    [50, 1, historyKinds.performances],
    [50, 1, historyKinds.performances],
  ]);
});

it('resets pagination on tab changes and ignores an old tab response', async () => {
  let finish = (_value: HistoryPageDto) => {};
  backend.history
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValueOnce(page('processing'))
    .mockResolvedValueOnce(page('fresh'));
  const { result } = renderHook(useHistory, { wrapper: QueryProvider });
  await waitFor(() => expect(backend.history).toHaveBeenCalledTimes(1));
  act(() => result.current.setTab('processing'));
  await waitFor(() => expect(result.current.events[0]?.id).toBe('processing'));
  await act(async () => finish(page('stale')));
  expect(result.current.events[0]?.id).toBe('processing');
  act(() => result.current.setTab('performances'));
  await waitFor(() => expect(result.current.events[0]?.id).toBe('fresh'));
  expect(backend.history).toHaveBeenLastCalledWith(
    50,
    0,
    historyKinds.performances,
  );
});

it('reads the first page and title catalog again after reopening', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  let finish = (_value: HistoryPageDto) => {};
  backend.history.mockResolvedValueOnce(page('old')).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const first = renderHook(useHistory, { wrapper });
  await waitFor(() => expect(first.result.current.events[0]?.id).toBe('old'));
  first.unmount();
  const next = renderHook(useHistory, { wrapper });
  expect(next.result.current.events).toEqual([]);
  expect(next.result.current.catalog.titles).toBeNull();
  await act(async () => finish(page('new')));
  await waitFor(() => expect(next.result.current.events[0]?.id).toBe('new'));
  expect(backend.listSongs).toHaveBeenCalledTimes(2);
  expect(backend.history.mock.calls.every(([, offset]) => offset === 0)).toBe(
    true,
  );
  next.unmount();
  client.clear();
});

it('retries the first history page without reloading a successful title catalog', async () => {
  backend.history
    .mockRejectedValueOnce(new Error('Unavailable'))
    .mockResolvedValueOnce(page('first'));
  const { result } = renderHook(useHistory, { wrapper: QueryProvider });
  await waitFor(() => expect(result.current.failed).toBe(true));
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.events).toHaveLength(1));
  expect(backend.listSongs).toHaveBeenCalledOnce();
});
