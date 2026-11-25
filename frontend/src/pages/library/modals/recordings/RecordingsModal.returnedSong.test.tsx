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
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  AnalysisDto,
  RecordingDto,
  SongDto,
} from '../../../../contracts/models';
import { NotificationsProvider } from '../../../../providers/notifications';
import { store } from '../../../../providers/store';
import '../../../../providers/localization';
import { recordingsChanged } from '../../../../services/backendEvents';
import { RecordingsModal } from './index';

const api = vi.hoisted(() => ({
  getSong: vi.fn(),
  listRecordings: vi.fn(),
  latestAnalysis: vi.fn(),
  analyzeRecording: vi.fn(),
  getRecording: vi.fn(),
}));
const desktop = vi.hoisted(() => ({
  recordingPeaks: vi.fn(),
  revealInExplorer: vi.fn(),
}));
vi.mock('../../../../services/pythonClient', () => ({ pythonClient: api }));
vi.mock('../../../../services/desktopClient', () => ({
  desktopClient: desktop,
}));
vi.mock('../../../../services/audioClient', () => ({ audioClient: {} }));

const archiveSong: SongDto = {
  id: 'archive-song',
  title: 'The archived song',
  artist: 'Archive singer',
  language: 'Auto',
  status: 'ready',
  durationSeconds: 30,
  createdAt: '2026-11-20T10:00:00Z',
  coverState: 'Fallback',
  activeRevision: 1,
  projectFormatVersion: 1,
};
const finishedSong: SongDto = {
  ...archiveSong,
  id: 'finished-song',
  title: 'The newly finished song',
  artist: 'New singer',
};
const archiveTake: RecordingDto = {
  id: 'archive-take',
  songId: archiveSong.id,
  filePath: '/archive-take.flac',
  displayName: 'The archived take',
  createdAt: archiveSong.createdAt,
  durationSeconds: 30,
  sizeBytes: 100,
  analyzed: true,
  fileStatus: 'Ready',
};
const finishedTake: RecordingDto = {
  ...archiveTake,
  id: 'finished-take',
  songId: finishedSong.id,
  filePath: '/finished-take.flac',
  displayName: 'The newly finished take',
};
const finishedMaster: RecordingDto = {
  ...finishedTake,
  id: 'finished-master',
  sourceRecordingId: finishedTake.id,
  filePath: '/finished-master.flac',
};
const analysis: AnalysisDto = {
  recordingId: finishedTake.id,
  score: 87,
  pitch: 80,
  rhythm: 90,
  stability: 90,
  summary: '',
};
const unavailable = {
  code: 'StorageUnavailable',
  message: 'Temporary archive read failure',
  source: 'python',
};
const deferred = <T,>() => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

let client: QueryClient;
const onAnalysisReady = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  store.setLanguage('ru');
  store.returnFromKaraoke(null);
  api.getSong.mockImplementation(async (id: string) =>
    id === finishedSong.id ? finishedSong : archiveSong,
  );
  api.listRecordings.mockImplementation(async (id: string) =>
    id === finishedSong.id ? [finishedTake] : [archiveTake],
  );
  api.latestAnalysis.mockImplementation(async (id: string) => ({
    ...analysis,
    recordingId: id,
  }));
  api.getRecording.mockResolvedValue(finishedTake);
  desktop.recordingPeaks.mockResolvedValue([]);
  desktop.revealInExplorer.mockResolvedValue(undefined);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  store.returnFromKaraoke(null);
});

const OpenArchive = () => {
  const [requestedSong, setRequestedSong] = useState<SongDto | null>(
    archiveSong,
  );
  return (
    <RecordingsModal
      requestedSong={requestedSong}
      onRequestHandled={() => setRequestedSong(null)}
      onAnalysisReady={onAnalysisReady}
    />
  );
};
const openArchive = () =>
  render(
    <QueryClientProvider client={client}>
      <NotificationsProvider>
        <OpenArchive />
      </NotificationsProvider>
    </QueryClientProvider>,
  );

const dialog = (selector: string) => {
  const result = document.querySelector<HTMLElement>(selector);
  if (!result) throw new Error(`Missing ${selector}`);
  return result;
};
const returnTake = async (take = finishedTake) => {
  act(() => {
    store.returnFromKaraoke({
      analysisSongId: take.songId,
      analysisFor: take.id,
    });
  });
  await screen.findByText('87', { selector: '[data-role="analysis-score"]' });
};

it.each(['loaded', 'failed', 'late-success', 'late-failure'] as const)(
  'closes the %s archive when another song returns without leaving its takes under the old title',
  async (state) => {
    const previous = deferred<RecordingDto[]>();
    if (state.startsWith('late-'))
      api.listRecordings.mockReturnValueOnce(previous.promise);
    else if (state === 'failed')
      api.listRecordings.mockRejectedValueOnce(unavailable);
    openArchive();
    if (state === 'loaded')
      await screen.findByText(archiveTake.displayName, {
        selector: '.recordingChoice strong',
      });
    else if (state === 'failed')
      await screen.findByText(tr('errors.recordings'));
    else
      expect(
        within(dialog('.recordingsDialog')).getByLabelText(
          tr('library.loading'),
        ),
      ).toBeVisible();

    await returnTake();
    if (state.startsWith('late-')) {
      await act(async () => {
        if (state === 'late-success') previous.resolve([archiveTake]);
        else previous.reject(unavailable);
      });
    }
    const current = dialog('.analysisDialog');
    expect(within(current).getByText(finishedSong.title)).toBeVisible();
    expect(onAnalysisReady).toHaveBeenLastCalledWith(finishedTake.id);
    expect(api.latestAnalysis).toHaveBeenLastCalledWith(finishedTake.id);
    fireEvent.click(within(current).getByLabelText(tr('openFolder')));
    await waitFor(() =>
      expect(desktop.revealInExplorer).toHaveBeenCalledWith(
        finishedTake.filePath,
      ),
    );
    expect(api.getRecording).toHaveBeenCalledExactlyOnceWith(finishedTake.id);
    expect(api.analyzeRecording).not.toHaveBeenCalled();
    if (state !== 'failed')
      expect(
        screen.queryByText(tr('errorStorageUnavailable')),
      ).not.toBeInTheDocument();
    expect(document.querySelector('.recordingsDialog')).not.toBeInTheDocument();

    fireEvent.click(within(current).getByLabelText(tr('closeDialog')));
    expect(document.querySelector('.analysisDialog')).not.toBeInTheDocument();
    expect(screen.queryByText(archiveSong.title)).not.toBeInTheDocument();
  },
);

it('refreshes the returned song after an archive of another song was open', async () => {
  openArchive();
  await screen.findByText(archiveTake.displayName, {
    selector: '.recordingChoice strong',
  });
  await returnTake();
  api.listRecordings.mockClear();
  api.listRecordings.mockImplementation(async (id: string) =>
    id === finishedSong.id ? [finishedTake, finishedMaster] : [archiveTake],
  );
  act(recordingsChanged);
  await waitFor(() =>
    expect(api.listRecordings).toHaveBeenCalledExactlyOnceWith(finishedSong.id),
  );
  await waitFor(() =>
    expect(desktop.recordingPeaks).toHaveBeenCalledWith(
      finishedMaster.id,
      240,
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    ),
  );
  const current = dialog('.analysisDialog');
  expect(within(current).getByText(finishedSong.title)).toBeVisible();
  expect(onAnalysisReady).toHaveBeenLastCalledWith(finishedTake.id);
  expect(
    within(current).queryByText(tr('studioMasterCreate')),
  ).not.toBeInTheDocument();
  expect(api.analyzeRecording).not.toHaveBeenCalled();
});

it('keeps the same-song archive available after closing its returned analysis', async () => {
  openArchive();
  await screen.findByText(archiveTake.displayName, {
    selector: '.recordingChoice strong',
  });
  await returnTake(archiveTake);
  expect(onAnalysisReady).toHaveBeenLastCalledWith(archiveTake.id);
  fireEvent.click(
    within(dialog('.analysisDialog')).getByLabelText(tr('closeDialog')),
  );
  expect(document.querySelector('.analysisDialog')).not.toBeInTheDocument();
  const archive = dialog('.recordingsDialog');
  expect(within(archive).getByText(archiveSong.title)).toBeVisible();
  expect(
    within(archive).getByText(archiveTake.displayName, {
      selector: '.recordingChoice strong',
    }),
  ).toBeVisible();
  expect(api.analyzeRecording).not.toHaveBeenCalled();
});
