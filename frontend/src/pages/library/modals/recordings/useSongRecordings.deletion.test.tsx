import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AnalysisDto, RecordingDto } from '../../../../contracts/models';
import { useSongRecordings } from './useSongRecordings';

const api = vi.hoisted(() => ({
  latestAnalysis: vi.fn(),
  deleteRecording: vi.fn(),
  listRecordings: vi.fn(),
}));
vi.mock('@neo-ui-kit/react', () => ({
  tr: (key: string) => key,
  useLocale: () => 'ru',
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
vi.mock('../../../../components/api-service', () => ({
  refreshSongs: vi.fn(),
}));
vi.mock('../../../../providers/store', () => ({
  store: { playback: { returned: null } },
}));
vi.mock('../../../../providers/dialog', () => ({ ask: async () => 'delete' }));
vi.mock('../../../../providers/notifications', () => ({
  useNotify: () => vi.fn(),
}));
vi.mock('../../../../services/pythonClient', () => ({ pythonClient: api }));
vi.mock('../../../../services/audioClient', () => ({
  audioClient: { stopRecordingPreview: vi.fn() },
}));
vi.mock('../../songs/useGuardedAction', () => ({
  useGuardedAction: () => (work: () => unknown) => work(),
}));

const take: RecordingDto = {
  id: 'take',
  songId: 'song',
  filePath: '/take.flac',
  displayName: '',
  createdAt: '',
  durationSeconds: 30,
  sizeBytes: 1000,
  analyzed: true,
  fileStatus: 'Ready',
};
const score: AnalysisDto = {
  recordingId: take.id,
  score: 80,
  pitch: 80,
  rhythm: 80,
  stability: 80,
  summary: '',
};
beforeEach(() => {
  api.latestAnalysis.mockResolvedValue(score);
  api.listRecordings.mockResolvedValue([]);
});
afterEach(() => vi.resetAllMocks());

it('closes the deleted take analysis and clears its selection', async () => {
  const { result } = renderHook(() =>
    useSongRecordings(null, vi.fn(), vi.fn()),
  );
  await act(() => result.current.analyze(take));
  expect(result.current.analysisRecordId).toBe(take.id);
  await act(() => result.current.remove(take));
  expect(api.deleteRecording).toHaveBeenCalledExactlyOnceWith(take.id);
  expect(result.current.analysisRecordId).toBeNull();
  expect(result.current.analysis).toBeNull();
});

it('does not reopen a deleted take when its outstanding analysis response arrives', async () => {
  let finish!: (value: AnalysisDto) => void;
  api.latestAnalysis.mockImplementationOnce(
    () =>
      new Promise<AnalysisDto>((resolve) => {
        finish = resolve;
      }),
  );
  const { result } = renderHook(() =>
    useSongRecordings(null, vi.fn(), vi.fn()),
  );
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.analyze(take);
  });
  await act(() => result.current.remove(take));
  await act(async () => {
    finish(score);
    await pending;
  });
  expect(result.current.analysisRecordId).toBeNull();
  expect(result.current.analysis).toBeNull();
  expect(result.current.analysisProgress).toEqual({});
});

it('keeps the master analysis selected when its original is deleted', async () => {
  const master = { ...take, id: 'master', sourceRecordingId: take.id };
  api.latestAnalysis.mockResolvedValue({ ...score, recordingId: master.id });
  const { result } = renderHook(() =>
    useSongRecordings(null, vi.fn(), vi.fn()),
  );
  await act(() => result.current.analyze(master));
  await act(() => result.current.remove(take));
  expect(result.current.analysisRecordId).toBe(master.id);
  expect(result.current.analysis?.recordingId).toBe(master.id);
});
