import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SongDto } from '../../../../contracts/models';
import { desktopClient } from '../../../../services/desktopClient';
import { pythonClient } from '../../../../services/pythonClient';
import { useLibraryImport } from './useLibraryImport';

const notifications = vi.hoisted(() => vi.fn());
vi.mock('../../../../providers/notifications', () => ({
  useNotify: () => notifications,
}));
vi.mock('../../../../services/desktopClient', () => ({
  desktopClient: { pickAudioFiles: vi.fn() },
}));
vi.mock('../../../../services/pythonClient', () => ({
  pythonClient: { importSong: vi.fn(), processSong: vi.fn() },
}));

let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(pythonClient.importSong).mockImplementation(async (path) => ({
    id: path,
    title: path,
    artist: 'Singer',
    language: 'Auto',
    status: 'ready',
    durationSeconds: 180,
    createdAt: '2026-11-20T00:00:00Z',
    coverState: 'Fallback',
    activeRevision: 1,
    projectFormatVersion: 1,
  }));
});
afterEach(() => client.clear());

const renderImport = () =>
  renderHook(useLibraryImport, {
    wrapper: ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });

// These formats are accepted by backend.songs.import_song.ImportSong.
it.each(['aac', 'opus', 'wma', 'AAC', 'OPUS', 'WMA'])(
  'imports a supported %s file dropped or opened from Explorer',
  async (extension) => {
    const path = `D:\\Music\\Пісня.${extension}`;
    const { result } = renderImport();

    await act(() => result.current.importFiles([path]));

    expect(pythonClient.importSong).toHaveBeenCalledWith(
      path,
      {},
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );
    expect(client.getQueryData<readonly SongDto[]>(['song-imports'])).toEqual(
      [],
    );
    expect(notifications).not.toHaveBeenCalledWith(expect.anything(), 'error');
  },
);

it('imports every supported file in a mixed picker selection', async () => {
  const paths = ['mp3', 'aac', 'opus', 'wma'].map(
    (extension) => `D:\\Music\\song.${extension}`,
  );
  vi.mocked(desktopClient.pickAudioFiles).mockResolvedValue(paths);
  const { result } = renderImport();

  await act(() => result.current.addSong());

  expect(
    vi.mocked(pythonClient.importSong).mock.calls.map(([path]) => path),
  ).toEqual(paths);
  expect(notifications).not.toHaveBeenCalledWith(expect.anything(), 'error');
});

it('still rejects unsupported drops before sending them to the importer', async () => {
  const { result } = renderImport();

  await act(() =>
    result.current.importFiles(['D:\\Music\\notes.txt', 'D:\\Music\\app.exe']),
  );

  expect(pythonClient.importSong).not.toHaveBeenCalled();
  expect(notifications).toHaveBeenCalledWith(expect.any(String), 'error');
});
