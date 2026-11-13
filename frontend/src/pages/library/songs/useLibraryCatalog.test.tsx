import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { pythonClient } from '../../../services/pythonClient';
import { libraryChanged } from '../../../services/backendEvents';
import { useLibraryCatalog } from './useLibraryCatalog';

vi.mock('../../../services/pythonClient', () => ({
  pythonClient: {
    searchSongs: vi.fn(async () => ({ items: [], nextCursor: null })),
  },
}));
vi.mock('../../../providers/store', () => ({
  store: {
    online: { room: null },
    preferences: { librarySort: 'recent', librarySortDirection: 'desc' },
    application: { services: { pythonEpoch: 0 } },
  },
}));
vi.mock('../../../providers/application', () => ({
  useJobs: () => ({ jobs: [] }),
}));

const filters = {
  status: 'all',
  language: 'all',
  duration: 'all',
  artwork: 'all',
} as const;
let client: QueryClient;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  client.clear();
  vi.useRealTimers();
});

it('reuses recent searches, invalidates changes and expires unused results', async () => {
  const { rerender, unmount } = renderHook(
    ({ query }) => useLibraryCatalog(query, filters, false),
    {
      initialProps: { query: '' },
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  await act(() => vi.advanceTimersByTimeAsync(1));
  for (const query of ['Adele', '', 'Adele', '']) {
    rerender({ query });
    await act(() => vi.advanceTimersByTimeAsync(1));
  }
  expect(pythonClient.searchSongs).toHaveBeenCalledTimes(2);
  act(() => libraryChanged());
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(pythonClient.searchSongs).toHaveBeenCalledTimes(3);
  rerender({ query: 'Adele' });
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(pythonClient.searchSongs).toHaveBeenCalledTimes(4);
  await act(() => vi.advanceTimersByTimeAsync(30_001));
  expect(
    client.getQueryCache().findAll({ queryKey: ['songs'], type: 'inactive' }),
  ).toHaveLength(0);
  rerender({ query: '' });
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(pythonClient.searchSongs).toHaveBeenCalledTimes(5);
  unmount();
});
