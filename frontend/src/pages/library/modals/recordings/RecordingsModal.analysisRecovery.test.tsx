import { tr } from '@neo-ui-kit/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  AnalysisDto,
  RecordingDto,
  SongDto,
} from '../../../../contracts/models';
import { store } from '../../../../providers/store';
import '../../../../providers/localization';
import { RecordingsModal } from './index';

const api = vi.hoisted(() => ({
  getSong: vi.fn(),
  listRecordings: vi.fn(),
  latestAnalysis: vi.fn(),
  analyzeRecording: vi.fn(),
  cancelJob: vi.fn(),
}));
const notify = vi.hoisted(() => vi.fn());
vi.mock('../../../../services/pythonClient', () => ({ pythonClient: api }));
vi.mock('../../../../providers/notifications', () => ({
  useNotify: () => notify,
}));
vi.mock('../../../../shared/hooks/useNearView', () => ({
  useNearView: () => false,
}));
vi.mock('./RecordingPlayer', () => ({
  RecordingPlayer: ({ recording }: { recording: RecordingDto }) => (
    <div data-testid={`player:${recording.id}`} />
  ),
}));

const song: SongDto = {
  id: 'song',
  title: 'Finished song',
  artist: 'Singer',
  language: 'Auto',
  status: 'ready',
  durationSeconds: 30,
  createdAt: '2026-11-20T10:00:00Z',
  coverState: 'Fallback',
  activeRevision: 1,
  projectFormatVersion: 1,
};
const take: RecordingDto = {
  id: 'take',
  songId: song.id,
  filePath: '/take.mp3',
  displayName: 'My performance',
  createdAt: song.createdAt,
  durationSeconds: 30,
  sizeBytes: 100,
  analyzed: true,
  fileStatus: 'Ready',
};
const analysis: AnalysisDto = {
  recordingId: take.id,
  score: 80,
  pitch: 80,
  rhythm: 80,
  stability: 80,
  summary: '',
};
const unavailable = {
  code: 'StorageUnavailable',
  message: 'Temporary read failure',
  source: 'python',
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  store.setLanguage('ru');
  store.returnFromKaraoke({ analysisSongId: song.id, analysisFor: take.id });
  api.getSong.mockResolvedValue(song);
  api.listRecordings.mockResolvedValue([take]);
  api.latestAnalysis.mockResolvedValue(analysis);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  store.returnFromKaraoke(null);
});

const openReturnedAnalysis = (requestedSong: SongDto | null = null) =>
  render(
    <QueryClientProvider client={client}>
      <RecordingsModal
        requestedSong={requestedSong}
        onRequestHandled={vi.fn()}
        onAnalysisReady={vi.fn()}
      />
    </QueryClientProvider>,
  );

it.each(['song', 'recordings'] as const)(
  'shows a closable analysis loader while returned-performance %s metadata is still loading',
  async (stage) => {
    const pending = deferred<SongDto | RecordingDto[]>();
    const request = stage === 'song' ? api.getSong : api.listRecordings;
    request.mockReturnValueOnce(pending.promise);
    openReturnedAnalysis();
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    try {
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByText(tr('analysisLoading'))).toBeVisible();
      expect(
        within(dialog).getByRole('button', { name: tr('closeDialog') }),
      ).toBeEnabled();
      expect(api.latestAnalysis).not.toHaveBeenCalled();
    } finally {
      await act(async () => pending.resolve(stage === 'song' ? song : [take]));
    }
    expect(await screen.findByTestId('player:take')).toBeVisible();
    expect(screen.queryByText(tr('analysisLoading'))).not.toBeInTheDocument();
  },
);

it.each(['song', 'recordings', 'analysis'] as const)(
  'keeps a failed %s request visible and retries the returned take from the dialog',
  async (stage) => {
    const request = {
      song: api.getSong,
      recordings: api.listRecordings,
      analysis: api.latestAnalysis,
    }[stage];
    request.mockRejectedValueOnce(unavailable);
    openReturnedAnalysis();
    await waitFor(() => expect(notify).toHaveBeenCalledOnce());
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByText(tr('errorStorageUnavailable')),
    ).toBeVisible();
    expect(
      within(dialog).queryByText(tr('analysisLoading')),
    ).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: tr('retry') }));
    expect(await screen.findByTestId('player:take')).toBeVisible();
    expect(api.getSong).toHaveBeenLastCalledWith(song.id);
    expect(api.latestAnalysis).toHaveBeenLastCalledWith(take.id);
    expect(api.analyzeRecording).not.toHaveBeenCalled();
    expect(
      screen.queryByText(tr('errorStorageUnavailable')),
    ).not.toBeInTheDocument();
  },
);

it.each(['success', 'failure'] as const)(
  'ignores a late metadata %s after the user closes the opening analysis',
  async (outcome) => {
    const pending = deferred<SongDto>();
    api.getSong.mockReturnValueOnce(pending.promise);
    openReturnedAnalysis();
    await waitFor(() => expect(api.getSong).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: tr('closeDialog') }));
    await act(async () => {
      if (outcome === 'success') pending.resolve(song);
      else pending.reject(unavailable);
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.listRecordings).not.toHaveBeenCalled();
    expect(api.latestAnalysis).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  },
);

it('retries analysis opened from the archive without resetting the archive or its name', async () => {
  store.returnFromKaraoke(null);
  api.latestAnalysis.mockRejectedValueOnce(unavailable);
  openReturnedAnalysis(song);
  fireEvent.click(
    await screen.findByRole('button', { name: tr('recordingOpenAnalysis') }),
  );
  await waitFor(() => expect(notify).toHaveBeenCalledOnce());
  const retry = screen.getByRole('button', { name: tr('retry') });
  const dialog = retry.closest('dialog');
  if (!dialog) throw new Error('The analysis dialog is missing');
  fireEvent.click(retry);
  expect(await screen.findByTestId('player:take')).toBeVisible();
  fireEvent.click(
    within(dialog).getByRole('button', { name: tr('closeDialog') }),
  );
  expect(screen.getByRole('button', { name: /My performance/ })).toBeVisible();
  expect(api.getSong).not.toHaveBeenCalled();
  expect(api.latestAnalysis).toHaveBeenCalledTimes(2);
});

it('keeps a newer returned take selected when older metadata arrives late', async () => {
  const pending = deferred<SongDto>();
  const nextSong = { ...song, id: 'next-song', title: 'Next song' };
  const nextTake = { ...take, id: 'next-take', songId: nextSong.id };
  api.getSong.mockReturnValueOnce(pending.promise).mockResolvedValue(nextSong);
  api.listRecordings.mockResolvedValue([nextTake]);
  api.latestAnalysis.mockResolvedValue({
    ...analysis,
    recordingId: nextTake.id,
  });
  openReturnedAnalysis();
  await waitFor(() => expect(api.getSong).toHaveBeenCalledOnce());
  act(() =>
    store.returnFromKaraoke({
      analysisSongId: nextSong.id,
      analysisFor: nextTake.id,
    }),
  );
  expect(await screen.findByTestId('player:next-take')).toBeVisible();
  await act(async () => pending.resolve(song));
  expect(screen.getByTestId('player:next-take')).toBeVisible();
  expect(screen.queryByTestId('player:take')).not.toBeInTheDocument();
  expect(api.latestAnalysis).toHaveBeenCalledExactlyOnceWith(nextTake.id);
  expect(notify).not.toHaveBeenCalled();
});

it.each(['AnalysisPitchUncertain', 'JobCancelled'])(
  'settles %s without leaving the opening loader stuck',
  async (code) => {
    api.latestAnalysis.mockResolvedValue(null);
    api.analyzeRecording.mockRejectedValue({
      code,
      message: code,
      source: 'python',
    });
    openReturnedAnalysis();
    await waitFor(() => expect(api.analyzeRecording).toHaveBeenCalledOnce());
    if (code === 'AnalysisPitchUncertain') {
      expect(
        await screen.findByRole('button', { name: tr('studioMasterCreate') }),
      ).toBeVisible();
      expect(document.querySelector('[data-role="analysis-score"]')).toBeNull();
    } else {
      await waitFor(() =>
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
      );
    }
    expect(notify).not.toHaveBeenCalled();
  },
);
