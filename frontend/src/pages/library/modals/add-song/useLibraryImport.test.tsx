import { act, renderHook } from '@testing-library/react';
import { tr } from '@neo-ui-kit/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SongDto } from '../../../../contracts/models';
import { desktopClient } from '../../../../services/desktopClient';
import { pythonClient } from '../../../../services/pythonClient';
import { useLibraryImport } from './useLibraryImport';
import '../../../../providers/localization';

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

it('reports the reason for each rejected file and continues the rest of a batch', async () => {
  expect(tr('songsImportFailed', { names: 'probe.mp3' })).toContain(
    'probe.mp3',
  );
  vi.mocked(pythonClient.importSong)
    .mockRejectedValueOnce({
      code: 'DuplicateSong',
      message: 'Duplicate content',
      source: 'python',
    })
    .mockRejectedValueOnce({
      code: 'SourceMissing',
      message: 'Source disappeared',
      source: 'python',
    });
  const paths = ['duplicate.mp3', 'missing.mp3', 'valid.mp3', 'notes.txt'].map(
    (name) => `D:\\Music\\${name}`,
  );
  const { result } = renderImport();
  await act(() => result.current.importFiles(paths));

  expect(
    vi.mocked(pythonClient.importSong).mock.calls.map(([path]) => path),
  ).toEqual(paths.slice(0, 3));
  expect(notifications).toHaveBeenCalledWith(
    tr('songsImportFailed', {
      names: [
        `notes.txt: ${tr('errorUnsupportedMedia')}`,
        `duplicate.mp3: ${tr('errorDuplicateSong')}`,
        `missing.mp3: ${tr('errorSourceMissing')}`,
      ].join(', '),
    }),
    'error',
  );
  expect(notifications).toHaveBeenCalledWith(
    tr('songsImported', { count: 1 }),
    'success',
  );
  expect(client.getQueryData(['song-imports'])).toEqual([]);
});

it.each(['batch', 'picker'])(
  'preserves an unfamiliar backend failure reason from %s',
  async (source) => {
    vi.mocked(pythonClient.importSong).mockRejectedValueOnce({
      code: 'ProbeFailed',
      message: 'Audio container could not be read',
      source: 'python',
    });
    const { result } = renderImport();
    const paths = ['D:\\Music\\track.mp3'];
    vi.mocked(desktopClient.pickAudioFiles).mockResolvedValue(paths);
    await act(() =>
      source === 'picker'
        ? result.current.addSong()
        : result.current.importFiles(paths),
    );

    const reason = `${tr('importFailed')}: Audio container could not be read`;
    expect(notifications).toHaveBeenCalledWith(
      source === 'picker'
        ? reason
        : tr('songsImportFailed', { names: `track.mp3: ${reason}` }),
      'error',
    );
    expect(client.getQueryData(['song-imports'])).toEqual([]);
  },
);
