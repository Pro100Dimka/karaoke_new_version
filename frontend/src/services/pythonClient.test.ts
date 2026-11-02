import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  changeModel,
  isActiveJob,
  jobQuery,
  modelKey,
} from '../api/api-service';
import { pythonClient } from './pythonClient';

type Call = {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
};

const installBridge = (
  reply: (call: Call) => { status: number; ok: boolean; body: unknown },
) => {
  const calls: Call[] = [];
  Object.assign(window, {
    desktop: {
      pythonRequest: vi.fn(async (call: Call) => {
        calls.push(call);
        return reply(call);
      }),
    },
  });
  return calls;
};

describe('pythonClient contract', () => {
  it.each(['export', 'import'] as const)(
    'follows library %s progress until the completed report',
    async (action) => {
      let reads = 0;
      const progress = vi.fn();
      const report: Record<string, unknown> = {
        export: { path: 'E:/exports/library.zip' },
        import: { imported: 2, skipped: 1 },
      }[action];
      const calls = installBridge((call) => {
        if (call.path === `/packages/library/${action}`)
          return {
            ok: true,
            status: 202,
            body: { jobId: 'library-job', state: 'Queued' },
          };
        return {
          ok: true,
          status: 200,
          body: {
            jobId: 'library-job',
            state: ++reads >= 2 ? 'Succeeded' : 'Running',
            overallProgress: reads >= 2 ? 1 : 0.25,
            report,
          },
        };
      });
      const result =
        action === 'export'
          ? await pythonClient.exportLibrary(progress)
          : await pythonClient.importLibrary(
              'E:/downloads/library.zip',
              progress,
            );
      expect(result).toEqual(action === 'export' ? report.path : report);
      expect(progress.mock.calls.map(([job]) => job.progress)).toEqual([
        25, 100,
      ]);
      expect(calls[0]).toMatchObject({
        method: 'POST',
        path: `/packages/library/${action}`,
        ...(action === 'import'
          ? { body: { path: 'E:/downloads/library.zip' } }
          : {}),
      });
    },
  );

  it('rejects a failed library export instead of returning an archive path', async () => {
    installBridge((call) => ({
      ok: true,
      status: 200,
      body:
        call.method === 'POST'
          ? { jobId: 'library-job', state: 'Queued' }
          : {
              jobId: 'library-job',
              state: 'Failed',
              error: { code: 'StorageUnavailable', message: 'Disk full' },
            },
    }));
    await expect(pythonClient.exportLibrary()).rejects.toMatchObject({
      code: 'StorageUnavailable',
      message: 'Disk full',
    });
  });

  const model = {
    modelId: 'speech/model + test',
    purpose: 'ASR',
    version: 'v1/2',
    size: 100,
    requiredDiskBytes: 268435656,
    state: 'Missing',
  } as const;

  it('reads model download progress through completion using the UI job query', async () => {
    const states = ['Queued', 'Running', 'Succeeded'];
    const progress = [0, 0.25, 1];
    let reads = 0;
    const calls = installBridge(() => {
      const index = reads++;
      return {
        status: 200,
        ok: true,
        body: {
          items: [
            {
              jobId: 'model-job',
              entityId: modelKey(model),
              state: states[index],
              stage: 'Download',
              stageProgress: progress[index],
              overallProgress: progress[index],
            },
          ],
        },
      };
    });
    const client = new QueryClient({
      defaultOptions: { queries: { gcTime: 0 } },
    });
    const results = [];
    for (let index = 0; index < states.length; index++)
      results.push(
        await client.fetchQuery(jobQuery('ModelDownload', modelKey(model))),
      );
    expect(results.map((job) => job?.state)).toEqual(states);
    expect(results.map((job) => job?.stageProgress)).toEqual(progress);
    expect(results.map(isActiveJob)).toEqual([true, true, false]);
    expect(calls).toEqual(
      states.map(() => ({
        method: 'GET',
        path: '/jobs?type=ModelDownload&entityId=speech%2Fmodel%20%2B%20test%3Av1%2F2&limit=1',
      })),
    );
    client.clear();
  });

  it.each([
    ['Missing', 'POST', '/download'],
    ['Ready', 'DELETE', ''],
  ] as const)(
    'sends the %s model action without waiting for a job',
    async (state, method, suffix) => {
      const calls = installBridge(() => ({
        status: 202,
        ok: true,
        body: { jobId: 'model-job', state: 'Queued' },
      }));
      await expect(changeModel({ ...model, state })).resolves.toMatchObject({
        jobId: 'model-job',
        state: 'Queued',
      });
      expect(calls).toEqual([
        { method, path: `/models/speech%2Fmodel%20%2B%20test/v1%2F2${suffix}` },
      ]);
    },
  );

  it.each(['Failed', 'Cancelled'])(
    'returns model outcome %s as an inactive job',
    async (state) => {
      installBridge(() => ({
        status: 200,
        ok: true,
        body: {
          items: [
            {
              jobId: 'model-job',
              entityId: modelKey(model),
              state,
              stage: null,
              stageProgress: 0,
              overallProgress: 0,
            },
          ],
        },
      }));
      const client = new QueryClient({
        defaultOptions: { queries: { gcTime: 0 } },
      });
      const job = await client.fetchQuery(
        jobQuery('ModelDownload', modelKey(model)),
      );
      expect(job).toMatchObject({ jobId: 'model-job', state });
      expect(isActiveJob(job)).toBe(false);
      client.clear();
    },
  );

  it('reports the job identity and analysis stage while waiting', async () => {
    const progress = vi.fn();
    installBridge((call) => ({
      status: 200,
      ok: true,
      body: call.path.endsWith('/analysis')
        ? { jobId: 'job' }
        : call.path === '/jobs/job'
          ? {
              jobId: 'job',
              state: 'Succeeded',
              stage: 'Scoring',
              overallProgress: 1,
            }
          : [
              {
                analysisId: 'result',
                recordingId: 'take',
                state: 'Succeeded',
                pitchAccuracyPercent: 100,
              },
            ],
    }));
    await pythonClient.analyzeRecording('take', progress);
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        recordingId: 'take',
        jobId: 'job',
        stage: 'Scoring',
        progress: 100,
      }),
    );
  });

  it("opens the newest successful analysis in the backend's newest-first history", async () => {
    installBridge(() => ({
      status: 200,
      ok: true,
      body: [
        { analysisId: 'running', recordingId: 'take', state: 'Running' },
        {
          analysisId: 'new',
          recordingId: 'take',
          state: 'Succeeded',
          pitchAccuracyPercent: 95,
          rhythmAccuracyPercent: 94,
          noteStabilityPercent: 93,
        },
        {
          analysisId: 'old',
          recordingId: 'take',
          state: 'Succeeded',
          pitchAccuracyPercent: 2,
          rhythmAccuracyPercent: 3,
          noteStabilityPercent: 4,
        },
      ],
    }));
    await expect(pythonClient.latestAnalysis('take')).resolves.toMatchObject({
      pitch: 95,
      rhythm: 94,
      stability: 93,
    });
  });

  it('opens the analysis returned by its completed job rather than another result in history', async () => {
    installBridge((call) => ({
      status: 200,
      ok: true,
      body:
        call.path === '/recordings/take/analysis'
          ? { jobId: 'job' }
          : call.path === '/jobs/job'
            ? {
                jobId: 'job',
                state: 'Succeeded',
                report: { analysisId: 'wanted' },
              }
            : [
                {
                  analysisId: 'other',
                  recordingId: 'take',
                  state: 'Succeeded',
                  pitchAccuracyPercent: 95,
                },
                {
                  analysisId: 'wanted',
                  recordingId: 'take',
                  state: 'Succeeded',
                  pitchAccuracyPercent: 88,
                },
                {
                  analysisId: 'old',
                  recordingId: 'take',
                  state: 'Succeeded',
                  pitchAccuracyPercent: 2,
                },
              ],
    }));
    await expect(pythonClient.analyzeRecording('take')).resolves.toMatchObject({
      pitch: 88,
    });
  });
  it('preserves the reason an offline performance cannot be scored reliably', async () => {
    installBridge((call) => ({
      status: 200,
      ok: true,
      body: call.path.startsWith('/jobs/')
        ? {
            jobId: 'analysis-job',
            state: 'Failed',
            error: {
              code: 'AnalysisPitchUncertain',
              message: 'Too little reliable pitch',
            },
          }
        : { jobId: 'analysis-job' },
    }));
    await expect(pythonClient.analyzeRecording('take')).rejects.toMatchObject({
      code: 'AnalysisPitchUncertain',
      source: 'python',
    });
  });
  it('keeps waiting for CPU vocal analysis beyond five minutes', async () => {
    vi.useFakeTimers();
    let now = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let polls = 0;
    installBridge((call) => {
      let body: unknown = { jobId: 'analysis-job' };
      if (call.path === '/jobs/analysis-job') {
        polls += 1;
        now = 301_000;
        body = {
          jobId: 'analysis-job',
          state: polls === 1 ? 'Running' : 'Succeeded',
        };
      }
      if (call.path.endsWith('/analyses'))
        body = [
          {
            analysisId: 'result',
            recordingId: 'take',
            state: 'Succeeded',
            pitchAccuracyPercent: 100,
            rhythmAccuracyPercent: 100,
            noteStabilityPercent: 100,
            sectionResults: [],
            problemRegions: [],
          },
        ];
      return { status: 200, ok: true, body };
    });
    try {
      const result = pythonClient.analyzeRecording('take').then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(await result).toMatchObject({ value: { recordingId: 'take' } });
      expect(polls).toBe(2);
    } finally {
      clock.mockRestore();
      vi.useRealTimers();
    }
  });
  it('realigns existing lyrics from the vocal stem with its own processing endpoint', async () => {
    const calls = installBridge(() => ({
      status: 202,
      ok: true,
      body: { jobId: 'lyrics-1', state: 'Queued' },
    }));
    expect(await pythonClient.processSong('a/b', 'lyrics')).toMatchObject({
      id: 'lyrics-1',
      songId: 'a/b',
      state: 'queued',
    });
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/songs/a%2Fb/processing/lyrics',
        body: { mode: 'Auto', onlineLyrics: true },
        headers: { 'Idempotency-Key': 'key-1' },
      },
    ]);
  });

  it('keeps the lyrics realignment operation when loading jobs for retry', async () => {
    installBridge(() => ({
      status: 200,
      ok: true,
      body: {
        items: [
          {
            jobId: 'lyrics-1',
            type: 'SongProcessing',
            entityId: 's',
            state: 'Failed',
            stage: 'ForcedAlignment',
            stageProgress: 0,
            overallProgress: 0,
            error: null,
            report: { timingOperation: 'lyrics' },
          },
        ],
        limit: 100,
        offset: 0,
      },
    }));
    expect(await pythonClient.listJobs()).toEqual([
      expect.objectContaining({ id: 'lyrics-1', timingOperation: 'lyrics' }),
    ]);
  });

  it('propagates the authoritative backend instance identity', async () => {
    installBridge((call) => ({
      status: 200,
      ok: true,
      body:
        call.path === '/health/ready'
          ? { ok: true, instanceId: 'backend-generation' }
          : { backendVersion: '1', apiVersion: 1 },
    }));
    expect(await pythonClient.health()).toMatchObject({
      instanceId: 'backend-generation',
    });
  });
  beforeEach(() => vi.stubGlobal('crypto', { randomUUID: () => 'key-1' }));
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, 'desktop');
  });

  it('deletes a song with DELETE on its encoded path', async () => {
    const calls = installBridge(() => ({ status: 204, ok: true, body: null }));
    await pythonClient.deleteSong('a/b');
    expect(calls).toEqual([
      {
        method: 'DELETE',
        path: '/songs/a%2Fb',
        body: undefined,
        headers: undefined,
      },
    ]);
  });

  it('sends the source path with an idempotency key when importing', async () => {
    const calls = installBridge((call) => ({
      status: call.path === '/songs/imports' ? 202 : 200,
      ok: true,
      body:
        call.path === '/songs/imports'
          ? { jobId: 'import-1', state: 'Queued' }
          : call.path === '/jobs/import-1'
            ? {
                jobId: 'import-1',
                type: 'SongImport',
                state: 'Succeeded',
                entityId: null,
                stage: 'Saving',
                stageProgress: 1,
                overallProgress: 1,
                error: null,
                report: { songId: 's' },
              }
            : {
                songId: 's',
                title: 'T',
                artist: 'A',
                status: 'Imported',
                activeRevision: 1,
                createdAt: '2026-01-01T00:00:00Z',
              },
    }));
    await pythonClient.importSong('C:/song.mp3');
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/songs/imports',
      body: { sourcePath: 'C:/song.mp3' },
      headers: { 'Idempotency-Key': 'key-1' },
    });
  });

  it('follows an import by its pushed changes and cancels it at once when aborted', async () => {
    let push: (event: unknown) => void = () => undefined;
    const running = {
      jobId: 'import-1',
      type: 'SongImport',
      state: 'Running',
      entityId: null,
      stage: 'Decoding',
      stageProgress: 0.5,
      overallProgress: 0.5,
      error: null,
    };
    const calls = installBridge((call) => ({
      status: 200,
      ok: true,
      body:
        call.path === '/songs/imports'
          ? { jobId: 'import-1', state: 'Queued' }
          : running,
    }));
    Object.assign(window.desktop!, {
      onBackendEvent: (listener: (event: unknown) => void) => {
        push = listener;
        return () => {
          push = () => undefined;
        };
      },
    });
    const controller = new AbortController();
    const progress = vi.fn();
    const importing = pythonClient.importSong(
      'C:/song.mp3',
      {},
      { signal: controller.signal, onProgress: progress },
    );
    await vi.waitFor(() =>
      expect(progress).toHaveBeenCalledWith(
        expect.objectContaining({ progress: 50 }),
      ),
    );

    push({ type: 'job.changed', data: { jobId: 'import-1' } });
    await vi.waitFor(() =>
      expect(
        calls.filter((call) => call.path === '/jobs/import-1'),
      ).toHaveLength(2),
    );

    const startedAt = Date.now();
    controller.abort();
    await expect(importing).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/jobs/import-1/cancel',
    });
  });

  it('sends the title and artist the user entered when importing', async () => {
    const calls = installBridge((call) => ({
      status: 200,
      ok: true,
      body:
        call.path === '/songs/imports'
          ? { jobId: 'import-1', state: 'Queued' }
          : call.path === '/jobs/import-1'
            ? {
                jobId: 'import-1',
                type: 'SongImport',
                state: 'Succeeded',
                entityId: null,
                stage: 'Saving',
                stageProgress: 1,
                overallProgress: 1,
                error: null,
                report: { songId: 's' },
              }
            : {
                songId: 's',
                title: 'T',
                artist: 'A',
                status: 'Imported',
                activeRevision: 1,
                createdAt: '2026-01-01T00:00:00Z',
              },
    }));
    await pythonClient.importSong('C:/song.mp3', {
      title: 'Кофе',
      artist: 'Нервы',
    });
    expect(calls[0]).toMatchObject({
      body: { sourcePath: 'C:/song.mp3', title: 'Кофе', artist: 'Нервы' },
    });
  });

  it('follows the cursor until the song list is exhausted', async () => {
    const song = {
      songId: 's',
      title: 'T',
      artist: 'A',
      status: 'Ready',
      activeRevision: 1,
      createdAt: '2026-01-01T00:00:00Z',
    };
    const calls = installBridge((call) => ({
      status: 200,
      ok: true,
      body: call.path.includes('cursor=c1')
        ? { items: [song], nextCursor: null }
        : { items: [song], nextCursor: 'c1' },
    }));
    const songs = await pythonClient.listSongs();
    expect(songs).toHaveLength(2);
    expect(
      calls
        .map((call) => call.path)
        .filter((path) => path.startsWith('/songs')),
    ).toEqual(['/songs?limit=200', '/songs?limit=200&cursor=c1']);
  });

  it('maps an error response to an AppError with the backend code and request id', async () => {
    installBridge(() => ({
      status: 409,
      ok: false,
      body: { code: 'RevisionConflict', message: 'stale', requestId: 'r-1' },
    }));
    await expect(pythonClient.getSong('s')).rejects.toMatchObject({
      code: 'RevisionConflict',
      message: 'stale',
      source: 'python',
      correlationId: 'r-1',
    });
  });

  it('falls back to an HTTP code when the error body is not an object', async () => {
    installBridge(() => ({ status: 503, ok: false, body: null }));
    await expect(pythonClient.getSong('s')).rejects.toMatchObject({
      code: 'Http503',
      source: 'python',
    });
  });

  it('waits for package export and returns the generated archive path', async () => {
    const calls = installBridge((call) => ({
      status: 200,
      ok: true,
      body:
        call.path === '/packages/export/song-1?revision=3'
          ? { jobId: 'job-export', state: 'Queued' }
          : {
              jobId: 'job-export',
              state: 'Succeeded',
              report: { path: 'D:/packages/song-1.zip' },
            },
    }));

    await expect(pythonClient.exportProject('song-1', 3)).resolves.toBe(
      'D:/packages/song-1.zip',
    );
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /packages/export/song-1?revision=3',
      'GET /jobs/job-export',
    ]);
  });

  it('waits for a downloaded package import and returns the imported song', async () => {
    const song = {
      songId: 'song-2',
      title: 'Shared',
      artist: 'Friend',
      status: 'Ready',
      activeRevision: 4,
      createdAt: '2026-01-01T00:00:00Z',
    };
    const calls = installBridge((call) => ({
      status: 200,
      ok: true,
      body:
        call.path === '/packages/import'
          ? { jobId: 'job-import', state: 'Queued' }
          : call.path === '/jobs/job-import'
            ? {
                jobId: 'job-import',
                state: 'Succeeded',
                report: { songId: 'song-2' },
              }
            : song,
    }));

    await expect(
      pythonClient.importProject('D:/downloads/song-2.zip'),
    ).resolves.toMatchObject({ id: 'song-2', activeRevision: 4 });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /packages/import',
      'GET /jobs/job-import',
      'GET /songs/song-2',
    ]);
  });

  it('can accept an older exact room revision when local history is newer', async () => {
    const song = {
      songId: 'song-2',
      title: 'Shared',
      artist: 'Friend',
      status: 'Ready',
      activeRevision: 3,
      createdAt: '2026-01-01T00:00:00Z',
    };
    const calls = installBridge((call) => ({
      status: 200,
      ok: true,
      body:
        call.path === '/packages/import'
          ? { jobId: 'job-import', state: 'Queued' }
          : call.path === '/jobs/job-import'
            ? {
                jobId: 'job-import',
                state: 'Succeeded',
                report: { songId: 'song-2' },
              }
            : song,
    }));

    await pythonClient.importProject('D:/downloads/song-2.zip', 'AcceptOlder');
    expect(calls[0]).toMatchObject({
      body: { path: 'D:/downloads/song-2.zip', decision: 'AcceptOlder' },
    });
  });

  it("reports why a package import failed, with the backend's own code", async () => {
    installBridge((call) => ({
      status: 200,
      ok: true,
      body:
        call.path === '/packages/import'
          ? { jobId: 'job-import', state: 'Queued' }
          : {
              jobId: 'job-import',
              state: 'Failed',
              error: {
                code: 'PackageConflict',
                message: 'Package conflicts with local project',
                details: { conflict: 'DivergentRevision' },
              },
            },
    }));

    await expect(
      pythonClient.importProject('D:/downloads/song-2.zip', 'AcceptOlder'),
    ).rejects.toMatchObject({
      code: 'PackageConflict',
      details: JSON.stringify({ conflict: 'DivergentRevision' }),
      source: 'python',
    });
  });
});
