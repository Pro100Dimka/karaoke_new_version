import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { SongDto } from '../../../../contracts/models';
import { pythonClient } from '../../../../services/pythonClient';
import { useSongRecordings } from './useSongRecordings';

vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
vi.mock('../../../../components/api-service', () => ({
  refreshSongs: vi.fn(),
}));
vi.mock('../../../../providers/store', () => ({
  store: { playback: { returned: null } },
}));
vi.mock('../../../../providers/notifications', () => ({
  useNotify: () => vi.fn(),
}));
vi.mock('../../../../services/audioClient', () => ({ audioClient: {} }));
vi.mock('../../songs/useGuardedAction', () => ({
  useGuardedAction: () => (work: () => unknown) => work(),
}));

afterEach(() => Reflect.deleteProperty(window, 'desktop'));

it('shows appended takes in the already open recordings list without a backend push or polling', async () => {
  let imported = false;
  let reads = 0;
  const take = {
    recordingId: 'original',
    songId: 'song',
    songRevision: 1,
    filePath: '/original.mp3',
    duration: 1,
    sampleRate: 44100,
    channels: 2,
    sizeBytes: 1000,
    createdAt: '',
    fileStatus: 'Ready',
  };
  Object.assign(window, {
    desktop: {
      // Library SQL restore does not publish recordings.changed.
      onBackendEvent: () => () => undefined,
      pythonRequest: vi.fn(async (call: PythonBridgeRequest) => {
        if (call.path.startsWith('/recordings?')) {
          reads += 1;
          return {
            ok: true,
            status: 200,
            body: {
              items: imported
                ? [
                    take,
                    {
                      ...take,
                      recordingId: 'master',
                      sourceRecordingId: 'original',
                    },
                  ]
                : [take],
            },
          };
        }
        if (call.method === 'POST')
          return {
            ok: true,
            status: 202,
            body: { jobId: 'library', state: 'Queued' },
          };
        imported = true;
        return {
          ok: true,
          status: 200,
          body: {
            jobId: 'library',
            state: 'Succeeded',
            report: {
              imported: 0,
              skipped: 1,
              recordingsAdded: 1,
              recordingsSkipped: 1,
            },
          },
        };
      }),
    },
  });
  const song: SongDto = {
    id: 'song',
    title: 'Song',
    artist: 'Artist',
    language: 'Auto',
    status: 'ready',
    durationSeconds: 1,
    createdAt: '',
    coverState: 'Fallback',
    activeRevision: 1,
    projectFormatVersion: 1,
  };
  const handled = vi.fn();
  const analyzed = vi.fn();
  const { result } = renderHook(() =>
    useSongRecordings(song, handled, analyzed),
  );
  await waitFor(() =>
    expect(result.current.recordings.map((item) => item.id)).toEqual([
      'original',
    ]),
  );

  await act(() => pythonClient.importLibrary('/backup.zip'));

  expect(result.current.recordings.map((item) => item.id)).toEqual([
    'original',
    'master',
  ]);
  expect(result.current.recordings[1]?.sourceRecordingId).toBe('original');
  expect(reads).toBe(2);
});
