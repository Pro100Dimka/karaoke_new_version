import { afterEach, expect, it, vi } from 'vitest';
import { pythonClient } from './pythonClient';
import { onRecordingsChange } from './backendEvents';
import { installBridge } from './pythonClientFixture';

afterEach(() => {
  Reflect.deleteProperty(window, 'desktop');
});

it.each([
  { imported: 0, skipped: 3, recordingsAdded: 2, recordingsSkipped: 0 },
  { imported: 2, skipped: 1 },
  { imported: 0, skipped: 1, recordingsAdded: 2 },
])(
  'preserves the reported import counts without inventing missing values (%j)',
  async (report) => {
    installBridge((call) => ({
      ok: true,
      status: 200,
      body:
        call.method === 'POST'
          ? { jobId: 'library', state: 'Queued' }
          : { jobId: 'library', state: 'Succeeded', report },
    }));
    const changed = vi.fn();
    const stop = onRecordingsChange(changed);
    try {
      await expect(pythonClient.importLibrary('/backup.zip')).resolves.toEqual(
        report,
      );
      expect(changed).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
    await pythonClient.importLibrary('/backup.zip');
    expect(changed).toHaveBeenCalledOnce();
  },
);

it('keeps the backend recording conflict and does not announce a successful refresh', async () => {
  installBridge((call) => ({
    ok: true,
    status: 200,
    body:
      call.method === 'POST'
        ? { jobId: 'library', state: 'Queued' }
        : {
            jobId: 'library',
            state: 'Failed',
            error: {
              code: 'LibraryRecordingConflict',
              message: 'A different recording already uses this identifier',
              details: { recordingId: 'take', reason: 'different checksum' },
            },
          },
  }));
  const changed = vi.fn();
  const stop = onRecordingsChange(changed);
  try {
    await expect(
      pythonClient.importLibrary('/backup.zip'),
    ).rejects.toMatchObject({
      code: 'LibraryRecordingConflict',
      message: 'A different recording already uses this identifier',
      details: expect.stringContaining('different checksum'),
    });
    expect(changed).not.toHaveBeenCalled();
  } finally {
    stop();
  }
});

it('re-reads a recording snapshot that started before a successful local import', async () => {
  let finish!: (value: PythonBridgeResponse) => void;
  let reads = 0;
  const restored = {
    recordingId: 'restored-take',
    songId: 'song',
    songRevision: 1,
    filePath: '/restored.mp3',
    duration: 1,
    sampleRate: 44100,
    channels: 2,
    sizeBytes: 1000,
    createdAt: '',
    fileStatus: 'Ready',
  };
  Object.assign(window, {
    desktop: {
      pythonRequest: vi.fn((call: PythonBridgeRequest) => {
        if (call.path.startsWith('/recordings?')) {
          if (++reads === 1)
            return new Promise<PythonBridgeResponse>((resolve) => {
              finish = resolve;
            });
          return Promise.resolve({
            ok: true,
            status: 200,
            body: { items: [restored] },
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          body:
            call.method === 'POST'
              ? { jobId: 'library', state: 'Queued' }
              : {
                  jobId: 'library',
                  state: 'Succeeded',
                  report: {
                    imported: 0,
                    skipped: 1,
                    recordingsAdded: 1,
                    recordingsSkipped: 0,
                  },
                },
        });
      }),
    },
  });
  const pending = pythonClient.listRecordings('song');
  await pythonClient.importLibrary('/backup.zip');
  finish({ ok: true, status: 200, body: { items: [] } });
  expect((await pending).map((item) => item.id)).toEqual(['restored-take']);
  expect(reads).toBe(2);
});
