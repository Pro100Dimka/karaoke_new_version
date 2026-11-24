import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  deferred,
  native,
  setup,
  song,
} from '../../test-fixtures/recordingLifecycle';

const finalizingTake = async (start = true) => {
  const context = await setup();
  let state = '4';
  let stopPath = 'D:/take.wav';
  context.audioRequest.mockImplementation(async (request) => {
    if (request.command === 'StopRecording')
      return state === '6'
        ? { status: 5, text: 'Recording capture read failed' }
        : { status: 0, text: stopPath };
    if (request.command === 'GetRecordingState')
      return request.args?.details
        ? state === '5'
          ? { status: 0, text: JSON.stringify(native) }
          : { status: 2, text: 'Recording is not finalized' }
        : { status: 0, text: state };
    if (request.command === 'GetDevices') return { status: 0, text: '' };
    if (['GetDiagnostics', 'GetPlaybackSnapshot'].includes(request.command))
      return {
        status: 0,
        text: 'SessionState: Running\nBackend: WASAPI Shared\nRuntimeOutputSampleRate: 48000\nRuntimeOutputChannels: 2\nPlaybackState: 2',
      };
    return { status: 0, text: 'Ok' };
  });
  if (start) await context.recordingCoordinator.start(song);
  return {
    ...context,
    setState: (value: string) => {
      state = value;
    },
    setStopPath: (value: string) => {
      stopPath = value;
    },
  };
};

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
});

it.each(['queued-after-start', 'pending-native-stop', 'accepted-native-stop'])(
  'lets a device switch finish during a room stop without a queue cycle: %s',
  async (stage) => {
    const context = await finalizingTake(false);
    const { recordingCoordinator: coordinator, audioRequest } = context;
    const { audioClient } = await import('./audioClient');
    const startReply = deferred();
    const stopReply = deferred();
    const respond = audioRequest.getMockImplementation()!;
    audioRequest.mockImplementation(async (request) => {
      if (
        request.command === 'StartRecording' &&
        stage === 'queued-after-start'
      )
        await startReply.promise;
      if (
        request.command === 'StopRecording' &&
        request.args?.async &&
        stage === 'pending-native-stop'
      )
        await stopReply.promise;
      return respond(request);
    });
    const starting = coordinator.start(song);
    if (stage !== 'queued-after-start') await starting;
    const onCaptured = vi.fn(async () => {
      await audioClient.stop();
    });
    const stopping = coordinator.stop(undefined, onCaptured);
    expect(coordinator.stop(undefined, onCaptured)).toBe(stopping);
    const stopped = stopping.catch((error: unknown) => error);
    if (stage === 'accepted-native-stop') await vi.advanceTimersByTimeAsync(0);
    const switched = audioClient
      .applyConfiguration({
        backend: 'WASAPI Shared',
        sampleRate: 48000,
        periodFrames: 0,
      })
      .catch((error: unknown) => error);
    try {
      await vi.advanceTimersByTimeAsync(0);
      if (stage !== 'accepted-native-stop')
        expect(
          audioRequest.mock.calls.some(
            ([request]) => request.command === 'Reconfigure',
          ),
        ).toBe(false);
      startReply.resolve();
      stopReply.resolve();
      await vi.advanceTimersByTimeAsync(0);
      const reconfigured = audioRequest.mock.calls.filter(
        ([request]) => request.command === 'Reconfigure',
      );
      expect(reconfigured).toHaveLength(1);
      expect(reconfigured[0]?.[0].args?.preserveRecording).toBeUndefined();
      context.setState('5');
      await vi.advanceTimersByTimeAsync(100);
      expect(await stopped).toEqual({ recording: false, recordingId: 'take' });
      expect(await switched).not.toBeInstanceOf(Error);
      expect(onCaptured).toHaveBeenCalledOnce();
    } finally {
      startReply.resolve();
      stopReply.resolve();
      coordinator.interrupt();
      await vi.advanceTimersByTimeAsync(100);
      await Promise.all([starting, stopped, switched]);
      await coordinator.stop();
    }
  },
);

it.each(['rejected', 'lost'])(
  'rejects a device switch when the pending native stop reply is %s',
  async (failure) => {
    const context = await finalizingTake();
    const { audioClient } = await import('./audioClient');
    const reply = deferred();
    const respond = context.audioRequest.getMockImplementation()!;
    context.audioRequest.mockImplementation(async (request) => {
      if (request.command === 'StopRecording' && request.args?.async) {
        await reply.promise;
        if (failure === 'lost') throw new Error('Stop reply lost');
        return { status: 5, text: 'Stop rejected' };
      }
      return respond(request);
    });
    const stopped = context.recordingCoordinator
      .stop()
      .catch((error: unknown) => error);
    const switched = audioClient
      .applyConfiguration({
        backend: 'WASAPI Shared',
        sampleRate: 48000,
        periodFrames: 0,
      })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    reply.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const message = failure === 'lost' ? 'Stop reply lost' : 'Stop rejected';
    expect(await stopped).toMatchObject({ message });
    expect(await switched).toMatchObject({ message });
    expect(
      context.audioRequest.mock.calls.some(
        ([request]) => request.command === 'Reconfigure',
      ),
    ).toBe(false);
    expect(context.inspectWave).not.toHaveBeenCalled();
    expect(context.recordingCoordinator.hasPendingTake()).toBe(true);
    const { command, enqueueAudioOperation } = await import('./audioSession');
    await enqueueAudioOperation(() =>
      command('SetGain', { target: 'mic', value: 0.5 }),
    );
    expect(context.audioRequest).toHaveBeenLastCalledWith({
      command: 'SetGain',
      args: { target: 'mic', value: 0.5 },
    });
  },
);

it('keeps the next recording behind a device switch even when the old file finishes first', async () => {
  const context = await finalizingTake();
  const { audioClient } = await import('./audioClient');
  const reply = deferred();
  const respond = context.audioRequest.getMockImplementation()!;
  context.audioRequest.mockImplementation(async (request) => {
    if (request.command === 'Reconfigure') await reply.promise;
    return respond(request);
  });
  const stopping = context.recordingCoordinator.stop();
  await vi.advanceTimersByTimeAsync(0);
  const switching = audioClient.applyConfiguration({
    backend: 'WASAPI Shared',
    sampleRate: 48000,
    periodFrames: 0,
  });
  await vi.advanceTimersByTimeAsync(0);
  const restarted = vi.fn();
  const starting = context.recordingCoordinator.start(song).then(restarted);
  try {
    context.setState('5');
    await vi.advanceTimersByTimeAsync(100);
    expect(context.inspectWave).toHaveBeenCalledOnce();
    expect(restarted).not.toHaveBeenCalled();
    expect(
      context.audioRequest.mock.calls.filter(
        ([request]) => request.command === 'PrepareRecording',
      ),
    ).toHaveLength(1);
    expect(
      context.audioRequest.mock.calls.filter(
        ([request]) => request.command === 'StartRecording',
      ),
    ).toHaveLength(1);
  } finally {
    reply.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([stopping, switching, starting]);
  }
  expect(restarted).toHaveBeenCalledWith({ recording: true });
  expect(
    context.audioRequest.mock.calls.filter(
      ([request]) => request.command === 'PrepareRecording',
    ),
  ).toHaveLength(2);
  expect(
    context.audioRequest.mock.calls.filter(
      ([request]) => request.command === 'StartRecording',
    ),
  ).toHaveLength(2);
  await context.recordingCoordinator.stop();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  Reflect.deleteProperty(window, 'desktop');
});

it('waits for native finalization without holding other audio work or publishing the unfinished file', async () => {
  const context = await finalizingTake();
  const {
    recordingCoordinator: coordinator,
    audioRequest,
    inspectWave,
    pythonRequest,
  } = context;
  const finished = vi.fn();
  const stopping = coordinator.stop().then(finished, finished);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(audioRequest).toHaveBeenCalledWith({
      command: 'StopRecording',
      args: { async: true },
    });
    expect(audioRequest).toHaveBeenCalledWith({
      command: 'GetRecordingState',
      args: undefined,
    });
    expect(finished).not.toHaveBeenCalled();
    expect(coordinator.hasPendingTake()).toBe(true);
    expect(inspectWave).not.toHaveBeenCalled();
    expect(
      pythonRequest.mock.calls.filter(
        ([request]) => request.path === '/recordings',
      ),
    ).toHaveLength(0);

    const { command, enqueueAudioOperation } = await import('./audioSession');
    await enqueueAudioOperation(() =>
      command('SetGain', { target: 'mic', value: 0.5 }),
    );
    expect(audioRequest).toHaveBeenCalledWith({
      command: 'SetGain',
      args: { target: 'mic', value: 0.5 },
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(
      audioRequest.mock.calls.filter(
        ([request]) => request.command === 'GetRecordingState',
      ),
    ).toHaveLength(1);
    expect(finished).not.toHaveBeenCalled();

    context.setState('5');
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(finished).toHaveBeenCalledWith({
      recording: false,
      recordingId: 'take',
    });
    expect(inspectWave).toHaveBeenCalledExactlyOnceWith('D:/take.wav');
    expect(coordinator.hasPendingTake()).toBe(false);
  } finally {
    context.setState('5');
    await vi.advanceTimersByTimeAsync(100);
    await stopping;
    await coordinator.stop();
  }
});

it('reports a finalization failure through the existing native diagnostic and retains the take', async () => {
  const context = await finalizingTake();
  const stopping = context.recordingCoordinator
    .stop()
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  context.setState('6');
  await vi.advanceTimersByTimeAsync(100);
  expect(await stopping).toMatchObject({
    message: 'Recording capture read failed',
  });
  expect(context.audioRequest).toHaveBeenLastCalledWith({
    command: 'StopRecording',
    args: undefined,
  });
  expect(context.inspectWave).not.toHaveBeenCalled();
  expect(context.recordingCoordinator.hasPendingTake()).toBe(true);
});

it('does not poll a replacement audio session when interrupted between finalization reads', async () => {
  const context = await finalizingTake();
  const stopping = context.recordingCoordinator
    .stop()
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  context.recordingCoordinator.interrupt();
  context.setState('5');
  await vi.advanceTimersByTimeAsync(100);
  expect(await stopping).toMatchObject({
    message: 'Recording audio session was interrupted',
  });
  expect(
    context.audioRequest.mock.calls.filter(
      ([request]) => request.command === 'GetRecordingState',
    ),
  ).toHaveLength(1);
  expect(context.inspectWave).not.toHaveBeenCalled();
  await context.recordingCoordinator.stop();
  expect(context.audioRequest).toHaveBeenLastCalledWith({
    command: 'StopRecording',
    args: undefined,
  });
  expect(context.pythonRequest).toHaveBeenCalledWith({
    method: 'POST',
    path: '/recordings/take/recover',
  });
});

it.each(['0', '1', '2', '3', 'invalid', ''])(
  'rejects unexpected recording state %j without publishing a partial file',
  async (state) => {
    const context = await finalizingTake();
    context.setState(state);
    const stopping = context.recordingCoordinator
      .stop()
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(await stopping).toMatchObject({
      message: expect.stringContaining('Unexpected recording state'),
    });
    expect(context.inspectWave).not.toHaveBeenCalled();
    expect(context.recordingCoordinator.hasPendingTake()).toBe(true);
  },
);

it('bounds a stalled finalization and retries the same pending take before allowing a new start', async () => {
  const context = await finalizingTake();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  const stopping = context.recordingCoordinator
    .stop()
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  clock.mockReturnValue(120_001);
  await vi.advanceTimersByTimeAsync(100);
  expect(await stopping).toMatchObject({
    message: 'Recording finalization timed out',
  });
  expect(context.recordingCoordinator.hasPendingTake()).toBe(true);
  expect(context.inspectWave).not.toHaveBeenCalled();

  const commandsBeforeRetry = context.audioRequest.mock.calls.length;
  await context.recordingCoordinator.pause();
  await context.recordingCoordinator.resume({
    sourceSeconds: 0,
    playbackRate: 1,
    keyShift: 0,
  });
  const reconfigure = vi.fn(async () => undefined);
  const resumedPosition = vi.fn(async () => 0);
  await context.recordingCoordinator.reconfigure(reconfigure, resumedPosition);
  expect(reconfigure).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(resumedPosition).not.toHaveBeenCalled();
  expect(context.audioRequest.mock.calls).toHaveLength(commandsBeforeRetry);

  context.setStopPath('D:/must-not-replace-the-accepted-path.wav');
  const restarted = vi.fn();
  const starting = context.recordingCoordinator.start(song).then(restarted);
  await vi.advanceTimersByTimeAsync(0);
  expect(restarted).not.toHaveBeenCalled();
  expect(
    context.audioRequest.mock.calls.filter(
      ([request]) => request.command === 'PrepareRecording',
    ),
  ).toHaveLength(1);
  context.setState('5');
  await vi.advanceTimersByTimeAsync(100);
  await starting;
  expect(context.inspectWave).toHaveBeenCalledExactlyOnceWith('D:/take.wav');
  expect(
    context.audioRequest.mock.calls.filter(
      ([request]) => request.command === 'StopRecording',
    ),
  ).toHaveLength(1);
  expect(
    context.audioRequest.mock.calls.filter(
      ([request]) => request.command === 'PrepareRecording',
    ),
  ).toHaveLength(2);
  await context.recordingCoordinator.stop();
});
