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
