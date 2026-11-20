import { afterEach, expect, it } from 'vitest';
import { pythonClient } from './pythonClient';
import { installBridge } from './pythonClientFixture';

afterEach(() => Reflect.deleteProperty(window, 'desktop'));

it.each([
  [
    'master',
    'StudioMasterTimelineUnavailable',
    'Recording timeline is invalid',
  ],
  ['import', 'DuplicateSong', 'This song is already in the library'],
])(
  'preserves the code, explanation and details of a failed %s job',
  async (operation, code, message) => {
    installBridge((call) => ({
      status: 200,
      ok: true,
      body:
        call.method === 'POST'
          ? { jobId: 'job', state: 'Queued' }
          : {
              jobId: 'job',
              state: 'Failed',
              overallProgress: 0.5,
              error: {
                code,
                message,
                details: { recordingId: 'take', stage: 'Preparing' },
              },
            },
    }));
    const result =
      operation === 'master'
        ? pythonClient.createStudioMaster('take')
        : pythonClient.importSong('/song.mp3');
    await expect(result).rejects.toMatchObject({
      code,
      message,
      source: 'python',
      details: JSON.stringify({ recordingId: 'take', stage: 'Preparing' }),
    });
  },
);

it('identifies a cancelled master even when its job has no error payload', async () => {
  installBridge((call) => ({
    status: 200,
    ok: true,
    body:
      call.method === 'POST'
        ? { jobId: 'job', state: 'Queued' }
        : { jobId: 'job', state: 'Cancelled' },
  }));
  await expect(pythonClient.createStudioMaster('take')).rejects.toMatchObject({
    code: 'JobCancelled',
    source: 'python',
  });
});

it('associates a completed import with its published song', async () => {
  installBridge(() => ({
    status: 200,
    ok: true,
    body: {
      items: [
        {
          jobId: 'import-job',
          type: 'SongImport',
          entityId: null,
          state: 'Succeeded',
          overallProgress: 1,
          report: { songId: 'saved-song' },
        },
      ],
    },
  }));
  await expect(pythonClient.listJobs()).resolves.toEqual([
    expect.objectContaining({ id: 'import-job', songId: 'saved-song' }),
  ]);
});
