import { tr } from '@neo-ui-kit/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  AnalysisDto,
  RecordingDto,
  SongDto,
} from '../../../../contracts/models';
import { NotificationsProvider } from '../../../../providers/notifications';
import { store } from '../../../../providers/store';
import '../../../../providers/localization';
import { RecordingsModal } from './index';

const api = vi.hoisted(() => ({
  listRecordings: vi.fn(),
  latestAnalysis: vi.fn(),
  analyzeRecording: vi.fn(),
  createStudioMaster: vi.fn(),
}));
const desktop = vi.hoisted(() => ({ recordingPeaks: vi.fn() }));
vi.mock('@neo-ui-kit/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@neo-ui-kit/react')>()),
  Planet: () => null,
  NeonWaves: () => null,
}));
vi.mock('../../../../services/pythonClient', () => ({ pythonClient: api }));
vi.mock('../../../../services/desktopClient', () => ({
  desktopClient: desktop,
}));
vi.mock('../../../../services/audioClient', () => ({ audioClient: {} }));

const song: SongDto = {
  id: 'song',
  title: 'Saved performance',
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
  filePath: '/take.flac',
  displayName: 'My performance',
  createdAt: song.createdAt,
  durationSeconds: 30,
  sizeBytes: 100,
  analyzed: false,
  analysisStatus: 'NotAnalyzed',
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
const master: RecordingDto = {
  ...take,
  id: 'master',
  filePath: '/master.flac',
  sourceRecordingId: take.id,
};

let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  store.setLanguage('ru');
  store.returnFromKaraoke(null);
  api.listRecordings.mockResolvedValue([take]);
  api.latestAnalysis.mockResolvedValue(null);
  desktop.recordingPeaks.mockResolvedValue([]);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  store.returnFromKaraoke(null);
});

const openArchive = () =>
  render(
    <QueryClientProvider client={client}>
      <NotificationsProvider>
        <RecordingsModal
          requestedSong={song}
          onRequestHandled={() => undefined}
          onAnalysisReady={() => undefined}
        />
      </NotificationsProvider>
    </QueryClientProvider>,
  );

it('explains a missing take file in analysis and retries after the file is restored', async () => {
  const missingFile = {
    code: 'RecordingFileMissing',
    message: 'Recording audio file is missing',
    source: 'python',
  };
  api.analyzeRecording
    .mockRejectedValueOnce(missingFile)
    .mockResolvedValue(analysis);
  openArchive();
  fireEvent.click(await screen.findByLabelText(tr('recordingAnalyze')));

  const retry = await screen.findByText(tr('retry'));
  const dialog = retry.closest('dialog');
  if (!dialog) throw new Error('The failed analysis dialog is missing');
  expect(within(dialog).getByText(tr('recordingFileMissing'))).toBeVisible();
  expect(
    screen.queryByText(missingFile.message, { exact: false }),
  ).not.toBeInTheDocument();
  expect(api.analyzeRecording).toHaveBeenCalledExactlyOnceWith(
    take.id,
    expect.any(Function),
  );

  fireEvent.click(retry);
  expect(await screen.findByText('80', { selector: 'strong' })).toBeVisible();
  expect(screen.queryByText(tr('retry'))).not.toBeInTheDocument();
  expect(api.analyzeRecording).toHaveBeenCalledTimes(2);
  expect(api.analyzeRecording).toHaveBeenLastCalledWith(
    take.id,
    expect.any(Function),
  );
});

it('explains a missing AD Master source file and retries the same take after restoration', async () => {
  const missingFile = {
    code: 'RecordingFileMissing',
    message: 'Recording file is unavailable',
    source: 'python',
  };
  api.latestAnalysis.mockResolvedValue(analysis);
  api.createStudioMaster
    .mockRejectedValueOnce(missingFile)
    .mockResolvedValue(master);
  await act(async () => {
    openArchive();
  });
  await act(async () => {
    fireEvent.click(screen.getByLabelText(tr('recordingAnalyze')));
  });
  await act(async () => {
    fireEvent.click(screen.getByText(tr('studioMasterCreate')));
  });

  expect(screen.getByText(tr('recordingFileMissing'))).toBeVisible();
  expect(
    screen.queryByText(missingFile.message, { exact: false }),
  ).not.toBeInTheDocument();
  expect(api.createStudioMaster).toHaveBeenCalledExactlyOnceWith(
    take.id,
    expect.any(Function),
  );
  await act(async () => {
    fireEvent.click(screen.getByText(tr('studioMasterCreate')));
  });

  expect(screen.getByText(tr('studioMasterReady'))).toBeVisible();
  expect(desktop.recordingPeaks).toHaveBeenCalledWith(master.id, 240);
  expect(api.createStudioMaster).toHaveBeenCalledTimes(2);
  expect(api.createStudioMaster).toHaveBeenLastCalledWith(
    take.id,
    expect.any(Function),
  );
  expect(screen.queryByText(tr('studioMasterCreate'))).not.toBeInTheDocument();
  expect(api.analyzeRecording).not.toHaveBeenCalled();
});
