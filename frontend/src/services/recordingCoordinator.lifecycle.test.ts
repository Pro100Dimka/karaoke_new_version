import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SongDto } from '../contracts/models';

const song = { id: 'song', activeRevision: 1 } as SongDto;
const native = {
  sampleRate: 44100,
  channels: 1,
  durationFrames: 44100,
  startSessionFrame: 88200,
  stopSessionFrame: 132300,
  startPlaybackPosition: 22050,
  overrunCount: 1,
  gapMetadataDropped: 0,
  staleBlocks: 2,
  gaps: [{ startFrame: 90000, frameCount: 128 }],
};
const responseText = (command: string): string => {
  const responses: Record<string, string> = {
    StopRecording: 'D:/take.wav',
    GetRecordingState: JSON.stringify(native),
  };
  return responses[command] ?? 'Ok';
};
const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const setup = async () => {
  const inspectWave = vi.fn(async () => ({
    durationSeconds: 1,
    sampleRate: 44100,
    channels: 1,
  }));
  const audioRequest = vi.fn(async (request: AudioBridgeRequest) => ({
    status: 0,
    text: responseText(request.command),
  }));
  const pythonRequest = vi.fn(async (request: PythonBridgeRequest) => ({
    ok: true,
    status: 200,
    body:
      request.path === '/recordings/target'
        ? { recordingId: 'take', filePath: 'D:/take.wav' }
        : {},
  }));
  Object.assign(window, {
    desktop: {
      audioRequest,
      pythonRequest,
      inspectWave,
    },
  });
  const { recordingCoordinator } = await import('./recordingCoordinator');
  return { recordingCoordinator, audioRequest, pythonRequest, inspectWave };
};

describe('recording lifecycle', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => Reflect.deleteProperty(window, 'desktop'));

  it.each([false, true])('keeps one recording target across a mode change, already paused=%s', async (paused) => {
    const { recordingCoordinator: coordinator, audioRequest, pythonRequest } = await setup();
    await coordinator.start(song);
    if (paused) await coordinator.pause();
    const switching = deferred();
    const changed = coordinator.reconfigure(async (format) => {
      expect(format).toMatchObject({ sampleRate: 44100, channels: 1 });
      await switching.promise;
    }, async () => 2);
    const stopped = coordinator.stop();
    await Promise.resolve();
    expect(audioRequest.mock.calls.some(([r]) => r.command === 'StopRecording')).toBe(false);
    switching.resolve();
    await changed;
    await stopped;
    const commands = audioRequest.mock.calls.map(([r]) => r.command);
    expect(commands.filter(c => c === 'PrepareRecording')).toHaveLength(1);
    expect(commands.filter(c => c === 'ResumeRecording')).toHaveLength(paused ? 0 : 1);
    expect(commands.filter(c => c === 'StopRecording')).toHaveLength(1);
    expect(pythonRequest.mock.calls.filter(([r]) => r.path === '/recordings/target')).toHaveLength(1);
  });

  it('resumes the same recording after a rejected switch has restored its device', async () => {
    const { recordingCoordinator: coordinator, audioRequest } = await setup();
    await coordinator.start(song);
    await expect(coordinator.reconfigure(async () => { throw new Error('Exclusive rejected'); },
      async () => 2)).rejects.toThrow('Exclusive rejected');
    expect(audioRequest.mock.calls.map(([r]) => r.command)).toEqual([
      'PrepareRecording', 'StartRecording', 'PauseRecording', 'GetRecordingState', 'ResumeRecording',
    ]);
    await coordinator.stop();
  });

  it('prepares one file for concurrent starts and finalizes once for concurrent stops', async () => {
    const {
      recordingCoordinator: coordinator,
      audioRequest,
      pythonRequest,
    } = await setup();
    await Promise.all([coordinator.start(song), coordinator.start(song)]);
    const results = await Promise.all([coordinator.stop(), coordinator.stop()]);
    expect(
      audioRequest.mock.calls.filter(([r]) => r.command === 'PrepareRecording'),
    ).toHaveLength(1);
    expect(
      audioRequest.mock.calls.filter(([r]) => r.command === 'StopRecording'),
    ).toHaveLength(1);
    expect(
      pythonRequest.mock.calls.filter(([r]) => r.path === '/recordings'),
    ).toHaveLength(1);
    expect(results.map((r) => r.recordingId)).toEqual(['take', 'take']);
  });

  it('orders stop after an unfinished start', async () => {
    const { recordingCoordinator: coordinator, audioRequest } = await setup();
    const starting = deferred();
    audioRequest.mockImplementation(async (request) => {
      if (request.command === 'StartRecording') await starting.promise;
      return { status: 0, text: responseText(request.command) };
    });
    const started = coordinator.start(song);
    await vi.waitFor(() =>
      expect(audioRequest).toHaveBeenCalledWith({
        command: 'StartRecording',
        args: undefined,
      }),
    );
    const stopped = coordinator.stop();
    starting.resolve();
    await started;
    expect((await stopped).recordingId).toBe('take');
    expect(
      audioRequest.mock.calls.filter(([r]) => r.command === 'StopRecording'),
    ).toHaveLength(1);
  });

  it('recovers an interrupted file before allocating and writing the next fragment', async () => {
    const { recordingCoordinator: coordinator, audioRequest, pythonRequest } =
      await setup();
    let target = 0;
    pythonRequest.mockImplementation(async (request) => ({
      ok: true,
      status: 200,
      body: request.path === '/recordings/target'
        ? { recordingId: `take-${++target}`, filePath: `D:/take-${target}.wav` }
        : {},
    }));
    await coordinator.start(song);
    coordinator.interrupt();
    await coordinator.start(song, { sourceSeconds: 12, playbackRate: 1, keyShift: 0 });
    const requests = pythonRequest.mock.calls.map(([request]) => request.path);
    expect(requests).toEqual([
      '/recordings/target', '/recordings/take-1/recover', '/recordings/target',
    ]);
    expect(audioRequest.mock.calls
      .filter(([request]) => request.command === 'PrepareRecording')
      .map(([request]) => request.args?.path))
      .toEqual(['D:/take-1.wav', 'D:/take-2.wav']);
    await expect(coordinator.stop()).resolves.toMatchObject({ recordingId: 'take-2' });
  });

  it('retains a prepared take when native Start fails, so Stop can still finalize it', async () => {
    const { recordingCoordinator: coordinator, audioRequest } = await setup();
    audioRequest.mockImplementation(async (request) => ({
      status: request.command === 'StartRecording' ? 1 : 0,
      text:
        request.command === 'StartRecording'
          ? 'start failed'
          : responseText(request.command),
    }));
    await expect(coordinator.start(song)).rejects.toThrow('start failed');
    expect(coordinator.hasPendingTake()).toBe(true);
    await expect(coordinator.stop()).resolves.toMatchObject({
      recordingId: 'take',
    });
    expect(
      audioRequest.mock.calls.filter(([r]) => r.command === 'StopRecording'),
    ).toHaveLength(1);
  });

  it('retains an allocated target after Prepare fails and cleans it when stopped', async () => {
    const {
      recordingCoordinator: coordinator,
      audioRequest,
      pythonRequest,
    } = await setup();
    audioRequest.mockImplementation(async (request) => ({
      status: request.command === 'PrepareRecording' ? 1 : 0,
      text: responseText(request.command),
    }));
    await expect(coordinator.start(song)).rejects.toThrow();
    expect(coordinator.hasPendingTake()).toBe(true);
    await expect(coordinator.stop()).resolves.toEqual({ recording: false });
    expect(pythonRequest).toHaveBeenCalledWith({
      method: 'DELETE',
      path: '/recordings/take',
    });
  });

  it('retries a failed native Start without preparing a second file or falsely reporting Recording', async () => {
    const { recordingCoordinator: coordinator, audioRequest } = await setup();
    let attempts = 0;
    audioRequest.mockImplementation(async (request) => ({
      status: request.command === 'StartRecording' && ++attempts === 1 ? 1 : 0,
      text:
        request.command === 'StartRecording'
          ? 'start failed'
          : responseText(request.command),
    }));
    await expect(coordinator.start(song)).rejects.toThrow('start failed');
    await expect(coordinator.start(song)).resolves.toMatchObject({
      recording: true,
    });
    expect(
      audioRequest.mock.calls.filter(([r]) => r.command === 'PrepareRecording'),
    ).toHaveLength(1);
    expect(attempts).toBe(2);
    await coordinator.stop();
  });

  it('retries registration without stopping an already finalized native take', async () => {
    const {
      recordingCoordinator: coordinator,
      audioRequest,
      pythonRequest,
    } = await setup();
    await coordinator.start(song);
    pythonRequest.mockRejectedValueOnce(new Error('backend restarted'));
    await expect(coordinator.stop()).rejects.toThrow('backend restarted');
    const saved = await coordinator.stop();
    expect(saved.recordingId).toBe('take');
    expect(
      audioRequest.mock.calls.filter(([r]) => r.command === 'StopRecording'),
    ).toHaveLength(1);
  });

  it('does not turn a successful recording command into an error because diagnostics failed', async () => {
    const { recordingCoordinator: coordinator, audioRequest } = await setup();
    audioRequest.mockImplementation(async (request) => {
      if (['GetDiagnostics', 'GetPlaybackSnapshot'].includes(request.command))
        throw new Error('diagnostics unavailable');
      return { status: 0, text: responseText(request.command) };
    });
    await expect(coordinator.start(song)).resolves.toMatchObject({
      recording: true,
    });
    await expect(coordinator.stop()).resolves.toMatchObject({
      recording: false,
      recordingId: 'take',
    });
  });

  it('persists native gap and dropped-frame metadata instead of reporting a gap-free recording', async () => {
    const { recordingCoordinator: coordinator, pythonRequest } = await setup();
    await coordinator.start(song);
    await coordinator.stop();
    const registered = pythonRequest.mock.calls.find(
      ([request]) => request.path === '/recordings',
    )?.[0];
    expect(registered?.body).toMatchObject({
      gaps: native.gaps,
      sessionMetadata: { nativeRecording: native },
    });
  });

  it('discards a zero-frame take without inventing duration or registering an empty performance', async () => {
    const {
      recordingCoordinator: coordinator,
      audioRequest,
      pythonRequest,
      inspectWave,
    } = await setup();
    inspectWave.mockResolvedValue({
      durationSeconds: 0,
      sampleRate: 44100,
      channels: 1,
    });
    audioRequest.mockImplementation(async (request) => ({
      status: 0,
      text:
        request.command === 'GetRecordingState'
          ? JSON.stringify({ ...native, durationFrames: 0 })
          : responseText(request.command),
    }));
    await coordinator.start(song);
    await expect(coordinator.stop()).resolves.toEqual({ recording: false });
    expect(pythonRequest).toHaveBeenCalledWith({
      method: 'DELETE',
      path: '/recordings/take',
    });
    expect(
      pythonRequest.mock.calls.filter(
        ([request]) => request.path === '/recordings',
      ),
    ).toHaveLength(0);
    expect(coordinator.hasPendingTake()).toBe(false);
  });

  it.each([
    'malformed',
    JSON.stringify({ ...native, gaps: [{ startFrame: -1, frameCount: 128 }] }),
  ])(
    'retains the finalized path and permits retry after invalid metadata: %s',
    async (invalid) => {
      const {
        recordingCoordinator: coordinator,
        audioRequest,
        pythonRequest,
      } = await setup();
      await coordinator.start(song);
      audioRequest.mockImplementation(async (request) => ({
        status: 0,
        text:
          request.command === 'GetRecordingState'
            ? invalid
            : responseText(request.command),
      }));
      await expect(coordinator.stop()).rejects.toThrow();
      expect(
        pythonRequest.mock.calls.filter(
          ([request]) => request.path === '/recordings',
        ),
      ).toHaveLength(0);
      audioRequest.mockImplementation(async (request) => ({
        status: 0,
        text: responseText(request.command),
      }));
      await expect(coordinator.stop()).resolves.toMatchObject({
        recordingId: 'take',
      });
      expect(
        audioRequest.mock.calls.filter(
          ([request]) => request.command === 'StopRecording',
        ),
      ).toHaveLength(1);
    },
  );
});
