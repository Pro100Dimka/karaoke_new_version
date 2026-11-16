import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBridge, model } from './pythonClientFixture';
import { QueryClient } from '@tanstack/react-query';
import { changeModel, isActiveJob, jobQuery, modelKey } from '../components/api-service';
import { pythonClient } from './pythonClient';
describe('pythonClient contract', () => {
  beforeEach(() => vi.stubGlobal('crypto', { randomUUID: () => 'key-1' }));

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, 'desktop');
  });

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

  it.each([1, 201])(
    'loads all job types and pages while preserving retry details (%i)',
    async (count) => {
      const calls = installBridge((call) => ({
        status: 200,
        ok: true,
        body: {
          items: Array.from(
            {
              length: Math.min(
                200,
                count -
                  Number(
                    new URL(call.path, 'http://backend').searchParams.get(
                      'offset',
                    ) ?? 0,
                  ),
              ),
            },
            (_, index) => {
              const offset = Number(
                new URL(call.path, 'http://backend').searchParams.get(
                  'offset',
                ) ?? 0,
              );
              return {
                jobId: `job-${offset + index}`,
                type: index === 0 ? 'ModelDownload' : 'SongProcessing',
                entityId: 's',
                state: 'Failed',
                stage: 'ForcedAlignment',
                stageProgress: 0,
                overallProgress: 0,
                error: null,
                report: { timingOperation: 'lyrics' },
              };
            },
          ),
          limit: 200,
          offset: Number(
            new URL(call.path, 'http://backend').searchParams.get('offset') ??
              0,
          ),
        },
      }));
      const jobs = await pythonClient.listJobs();
      expect(jobs).toHaveLength(count);
      expect(jobs.at(-1)).toMatchObject({
        id: `job-${count - 1}`,
        timingOperation: 'lyrics',
      });
      expect(jobs[0]?.type).toBe('ModelDownload');
      expect(
        calls.every(
          (call) =>
            !new URL(call.path, 'http://backend').searchParams.has('type'),
        ),
      ).toBe(true);
    },
  );
});
