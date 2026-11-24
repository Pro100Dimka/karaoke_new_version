import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => vi.resetModules());
afterEach(() => {
  Reflect.deleteProperty(window, 'desktop');
  vi.restoreAllMocks();
});

const setup = async () => {
  let now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const ticks = () => (now + 10000) * 1e6;
  let deliver: Parameters<DesktopApi['onAudioNotification']>[2] = () =>
    undefined;
  const unsubscribe = vi.fn();
  const text = (position: number, at = ticks()) =>
    `MonotonicTicks: ${at}\nRuntimeOutputSampleRate: 48000\nPlaybackState: 3\nPlaybackPresentationPositionFrames: ${position}\nInputPitchHz: 440`;
  const audioRequest = vi.fn(
    async (request: AudioBridgeRequest): Promise<AudioBridgeResponse> => {
      if (!request.command.startsWith('Get')) now += 10;
      return { status: 0, text: text(480000) };
    },
  );
  Object.assign(window, {
    desktop: {
      audioRequest,
      onAudioNotification: (
        _command: string,
        _interval: number,
        listener: Parameters<DesktopApi['onAudioNotification']>[2],
      ) => {
        deliver = listener;
        return unsubscribe;
      },
    },
  });
  const session = await import('./audioSession');
  return {
    session,
    audioRequest,
    unsubscribe,
    ticks,
    advance: () => {
      now += 16;
    },
    emit: (position: number, at = ticks()) =>
      deliver({ status: 0, observedAt: at, text: text(position, at) }),
    disconnect: () => deliver(null),
    flush: () => session.enqueueAudioOperation(async () => undefined),
  };
};

it('delivers native position and pitch without a read request and ignores events after cleanup', async () => {
  const context = await setup();
  const received = vi.fn();
  const failed = vi.fn();
  const stop = context.session.observeSnapshots(received, failed);
  context.emit(48000);
  await context.flush();
  expect(received).toHaveBeenLastCalledWith(
    expect.objectContaining({ positionSeconds: 1, pitchHz: 440 }),
  );
  expect(context.audioRequest).not.toHaveBeenCalled();
  stop();
  context.advance();
  context.emit(96000);
  await context.flush();
  expect(received).toHaveBeenCalledOnce();
  expect(context.unsubscribe).toHaveBeenCalledOnce();
  expect(failed).not.toHaveBeenCalled();
});

it('coalesces a burst behind a busy command queue to its most recent snapshot', async () => {
  const context = await setup();
  const received = vi.fn();
  const stop = context.session.observeSnapshots(received, vi.fn());
  let release: () => void = () => undefined;
  const held = context.session.enqueueAudioOperation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await Promise.resolve();
  for (let position = 1; position <= 1000; position++) {
    context.advance();
    context.emit(position * 48000);
  }
  release();
  await held;
  await context.flush();
  expect(received).toHaveBeenCalledOnce();
  expect(received).toHaveBeenLastCalledWith(
    expect.objectContaining({ positionSeconds: 1000 }),
  );
  stop();
});

it('reports an asynchronous snapshot consumer failure through the subscription', async () => {
  const context = await setup();
  const failure = new Error('Monitoring reconciliation failed');
  const failed = vi.fn();
  const stop = context.session.observeSnapshots(async () => {
    throw failure;
  }, failed);
  context.emit(48000);
  await context.flush();
  expect(failed).toHaveBeenCalledExactlyOnceWith(failure);
  stop();
});

it.each(['resolves', 'rejects'] as const)(
  'delivers the final snapshot behind queued controls when a slow consumer %s',
  async (completion) => {
    const context = await setup();
    let release!: () => void;
    const failure = new Error('Monitoring reconciliation failed');
    const failed = vi.fn();
    const held = new Promise<void>((resolve, reject) => {
      release = completion === 'resolves' ? resolve : () => reject(failure);
    });
    const order: (number | string)[] = [];
    const stop = context.session.observeSnapshots(async (value) => {
      order.push(value.positionSeconds);
      if (value.positionSeconds === 1) await held;
    }, failed);
    context.emit(48000);
    await Promise.resolve();
    expect(order).toEqual([1]);
    for (let position = 2; position <= 1000; position++) {
      context.advance();
      context.emit(position * 48000);
    }
    const control = context.session.enqueueAudioOperation(async () => {
      order.push('control');
    });
    release();
    await control;
    await context.flush();
    await context.flush();

    expect(order).toEqual([1, 'control', 1000]);
    if (completion === 'rejects')
      expect(failed).toHaveBeenCalledExactlyOnceWith(failure);
    else expect(failed).not.toHaveBeenCalled();
    stop();
  },
);

it('discards a trailing pre-seek snapshot without relabeling it with the new command revision', async () => {
  const context = await setup();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const received = vi.fn(async (value: { positionSeconds: number }) => {
    if (value.positionSeconds === 1) await held;
  });
  const stop = context.session.observeSnapshots(received, vi.fn());
  context.emit(48000);
  await Promise.resolve();
  context.advance();
  context.emit(96000);
  const seek = context.session.enqueueAudioOperation(() =>
    context.session.command('Seek', { frame: 480000 }),
  );
  release();
  await seek;
  await context.flush();
  await context.flush();
  expect(received).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ positionSeconds: 1 }),
  );
  context.advance();
  context.emit(480000);
  await context.flush();
  expect(received).toHaveBeenCalledTimes(2);
  expect(received).toHaveBeenLastCalledWith(
    expect.objectContaining({ positionSeconds: 10 }),
  );
  stop();
});

it('discards trailing snapshots and errors when unsubscribed during a slow consumer', async () => {
  const context = await setup();
  let reject!: (error: Error) => void;
  const held = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  const received = vi.fn(async () => held);
  const failed = vi.fn();
  const stop = context.session.observeSnapshots(received, failed);
  context.emit(48000);
  await Promise.resolve();
  context.advance();
  context.emit(96000);
  stop();
  reject(new Error('Consumer closed'));
  await context.flush();
  await context.flush();
  expect(received).toHaveBeenCalledOnce();
  expect(failed).not.toHaveBeenCalled();
  expect(context.unsubscribe).toHaveBeenCalledOnce();
});

it('keeps a newer pending stream frame when an older recovery snapshot arrives later', async () => {
  const context = await setup();
  const received = vi.fn();
  const stop = context.session.observeSnapshots(received, vi.fn());
  let release!: () => void;
  const held = context.session.enqueueAudioOperation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await Promise.resolve();
  const older = context.ticks();
  let finishRecovery!: (response: AudioBridgeResponse) => void;
  context.audioRequest.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRecovery = resolve;
      }),
  );
  context.disconnect();
  context.advance();
  context.emit(96000);
  context.emit(0, Number.NaN);
  finishRecovery({
    status: 0,
    text: `MonotonicTicks: ${older}\nRuntimeOutputSampleRate: 48000\nPlaybackState: 3\nPlaybackPresentationPositionFrames: 48000`,
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  release();
  await held;
  await context.flush();

  expect(received).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ positionSeconds: 2 }),
  );
  stop();
});

it('discards a recovery started before Seek even before the native clock is calibrated', async () => {
  const context = await setup();
  const received = vi.fn();
  const stop = context.session.observeSnapshots(received, vi.fn());
  let finishRecovery!: (response: AudioBridgeResponse) => void;
  const recovery = new Promise<AudioBridgeResponse>((resolve) => {
    finishRecovery = resolve;
  });
  context.audioRequest.mockReturnValueOnce(recovery);
  const beforeSeek = context.ticks();
  context.disconnect();
  await context.session.command('Seek', { frame: 480000 });
  finishRecovery({
    status: 0,
    text: `MonotonicTicks: ${beforeSeek}\nRuntimeOutputSampleRate: 48000\nPlaybackState: 3\nPlaybackPresentationPositionFrames: 48000`,
  });
  await recovery;
  await context.flush();
  await context.flush();
  expect(received).not.toHaveBeenCalled();
  context.advance();
  context.emit(480000);
  await context.flush();
  expect(received).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ positionSeconds: 10 }),
  );
  stop();
});

it('rejects pre-seek frames delivered after the reply while mixer changes retain live updates', async () => {
  const context = await setup();
  await context.session.diagnostics(true);
  const received = vi.fn();
  const stop = context.session.observeSnapshots(received, vi.fn());
  const beforeSeek = context.ticks();
  await context.session.command('Seek', { frame: 480000 });
  context.emit(48000, beforeSeek);
  await context.flush();
  expect(received).not.toHaveBeenCalled();
  context.advance();
  context.emit(480000);
  await context.flush();
  expect(received).toHaveBeenCalledOnce();
  const beforeMixer = context.ticks();
  await context.session.command('SetGain', { target: 'music', value: 0.5 });
  context.emit(480100, beforeMixer);
  await context.flush();
  expect(received).toHaveBeenCalledTimes(2);
  stop();
});

it('shares one recovery read for missed events and ignores its result after cleanup', async () => {
  const context = await setup();
  let resolve: (response: AudioBridgeResponse) => void = () => undefined;
  context.audioRequest.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const received = vi.fn();
  const stop = context.session.observeAudioTelemetry(
    'GetInputLevel',
    50,
    received,
    vi.fn(),
  );
  context.disconnect();
  context.disconnect();
  expect(context.audioRequest).toHaveBeenCalledOnce();
  stop();
  resolve({ status: 0, text: 'rms=0.5' });
  await context.flush();
  expect(received).not.toHaveBeenCalled();
});
