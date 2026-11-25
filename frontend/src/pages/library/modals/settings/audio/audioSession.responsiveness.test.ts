import { expect, it, vi } from 'vitest';
import type { SettingsAudioPort } from '../../../../../application/settings/SettingsPorts';
import type {
  DeviceDto,
  RequestedAudioConfiguration,
  RuntimeAudioConfiguration,
} from '../../../../../contracts/models';
import { audioSessionFor } from './audioSession';

const request = (periodFrames: number): RequestedAudioConfiguration => ({
  backend: 'WASAPI Shared',
  sampleRate: 48000,
  periodFrames,
});
const runtime = (
  value: RequestedAudioConfiguration,
): RuntimeAudioConfiguration => ({
  ...value,
  endpointBufferFrames: value.periodFrames,
  estimatedLatencyMs: null,
});
const setup = () => {
  const audio = {
    applyConfiguration: vi.fn(async (value: RequestedAudioConfiguration) =>
      runtime(value),
    ),
    setPreferredConfiguration: vi.fn(),
  } as unknown as SettingsAudioPort;
  const session = audioSessionFor(audio, request(480));
  const effects = { onAccepted: vi.fn(), onError: vi.fn() };
  return { session, audio, effects };
};

it('applies only the latest adjacent configuration before hardware work starts', async () => {
  const { session, audio, effects } = setup();
  const pending = Array.from({ length: 30 }, (_, index) =>
    session.apply(request(128 + index), effects),
  );
  expect(session.getSnapshot()).toMatchObject({
    requested: request(157),
    accepted: request(480),
    applying: true,
  });

  await Promise.all(pending);

  expect(audio.applyConfiguration).toHaveBeenCalledTimes(1);
  expect(audio.applyConfiguration).toHaveBeenLastCalledWith(request(157));
  expect(effects.onAccepted).toHaveBeenCalledExactlyOnceWith(request(157));
  expect(session.getSnapshot()).toMatchObject({
    accepted: request(157),
    requested: request(157),
    applying: false,
  });
});

it('finishes an in-flight change and keeps only the latest waiting configuration', async () => {
  const { session, audio, effects } = setup();
  let finish!: (value: RuntimeAudioConfiguration) => void;
  vi.mocked(audio.applyConfiguration).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = session.apply(request(128), effects);
  await Promise.resolve();
  expect(audio.applyConfiguration).toHaveBeenCalledTimes(1);
  const pending = Array.from({ length: 30 }, (_, index) =>
    session.apply(request(256 + index), effects),
  );
  expect(session.getSnapshot()).toMatchObject({
    requested: request(285),
    accepted: request(480),
    applying: true,
  });
  finish(runtime(request(128)));
  await Promise.all([first, ...pending]);

  expect(vi.mocked(audio.applyConfiguration).mock.calls).toEqual([
    [request(128)],
    [request(285)],
  ]);
  expect(effects.onAccepted).toHaveBeenCalledExactlyOnceWith(request(285));
  expect(session.getSnapshot().applying).toBe(false);
});

it('preserves explicit queue barriers between configuration changes', async () => {
  const { session, audio, effects } = setup();
  const first = session.apply(request(128), effects);
  const atBarrier: RequestedAudioConfiguration[] = [];
  const barrier = session.enqueue(async () => {
    atBarrier.push(session.getSnapshot().accepted);
  });
  const second = session.apply(request(256), effects);
  const latest = session.apply(request(512), effects);
  await Promise.all([first, barrier, second, latest]);

  expect(atBarrier).toEqual([request(128)]);
  expect(vi.mocked(audio.applyConfiguration).mock.calls).toEqual([
    [request(128)],
    [request(512)],
  ]);
  expect(effects.onAccepted).toHaveBeenCalledExactlyOnceWith(request(512));
});

it('retains and persists the last accepted configuration when the latest change fails', async () => {
  const { session, audio, effects } = setup();
  let finish!: (value: RuntimeAudioConfiguration) => void;
  const failure = new Error('Driver rejected the latest buffer');
  vi.mocked(audio.applyConfiguration)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockRejectedValueOnce(failure);
  const first = session.apply(request(128), effects);
  await Promise.resolve();
  const skippedEffects = { onAccepted: vi.fn(), onError: vi.fn() };
  const second = session.apply(request(256), skippedEffects);
  const latest = session.apply(request(512), effects);
  finish(runtime(request(128)));
  await Promise.all([first, second, latest]);

  expect(vi.mocked(audio.applyConfiguration).mock.calls).toEqual([
    [request(128)],
    [request(512)],
  ]);
  expect(effects.onError).toHaveBeenCalledExactlyOnceWith(failure);
  expect(skippedEffects.onError).not.toHaveBeenCalled();
  expect(effects.onAccepted).toHaveBeenCalledExactlyOnceWith(request(128));
  expect(session.getSnapshot()).toMatchObject({
    requested: request(128),
    accepted: request(128),
    applying: false,
  });
});

it('does not apply obsolete ASIO preparation when the user has already chosen Windows audio', async () => {
  const { session, audio, effects } = setup();
  const driver: DeviceDto = {
    id: 'asio-driver',
    name: 'ASIO',
    backend: 'ASIO',
    kind: 'output',
    channels: 2,
  };
  const prepared = session.prepareAsio(
    {
      ...request(128),
      backend: 'ASIO',
      inputDeviceId: driver.id,
      outputDeviceId: driver.id,
    },
    driver,
    effects,
  );
  const latest = session.apply(request(512), effects);
  await Promise.all([prepared, latest]);

  expect(audio.setPreferredConfiguration).not.toHaveBeenCalled();
  expect(audio.applyConfiguration).toHaveBeenCalledExactlyOnceWith(
    request(512),
  );
  expect(session.getSnapshot()).toMatchObject({
    accepted: request(512),
    asioReadyToRestart: false,
    applying: false,
  });
});
