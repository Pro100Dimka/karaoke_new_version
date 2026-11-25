import { expect, it, vi } from 'vitest';
import { applyVoiceChain } from './voiceChain';
import { audioClient } from '../../../services/audioClient';
import { installBridge } from '../../../services/audioClientFixture';

const settings = {
  voiceGain: 1,
  karaokeEffects: { echo: 0.1, reverb: 0.2, delay: 0.3, autoTune: 0.4 },
  noiseSuppression: 0.5,
};

const fixture = () => {
  const applied = new Map<string, number>();
  const port = {
    setMixer: vi.fn(async () => undefined),
    setDspParameter: vi.fn(async (name: string, value: number) => {
      applied.set(name, value);
    }),
    setDspEnabled: vi.fn(async () => undefined),
  };
  return { port, applied };
};

it('does not resend all nine DSP parameters for each microphone volume gesture', async () => {
  const { port, applied } = fixture();
  await applyVoiceChain(settings, port);
  expect(port.setDspParameter).toHaveBeenCalledTimes(9);
  const original = new Map(applied);
  port.setDspParameter.mockClear();
  port.setMixer.mockClear();

  for (let index = 0; index < 100; index++)
    await applyVoiceChain({ ...settings, voiceGain: 0.5 + index / 100 }, port);

  expect(port.setDspParameter.mock.calls).toHaveLength(0);
  expect(port.setMixer).toHaveBeenCalledTimes(100);
  expect(port.setMixer).toHaveBeenLastCalledWith('mic', 1.49);
  expect(port.setDspEnabled).toHaveBeenLastCalledWith(true);
  expect(applied).toEqual(original);
});

it('sends only the changed effect parameter even when every settings object is new', async () => {
  const { port, applied } = fixture();
  await applyVoiceChain(settings, port);
  port.setDspParameter.mockClear();

  for (let index = 0; index < 2; index++)
    await applyVoiceChain(
      {
        ...settings,
        karaokeEffects: { ...settings.karaokeEffects, echo: 0.7 },
      },
      port,
    );

  expect(port.setDspParameter).toHaveBeenCalledExactlyOnceWith(
    'echo.amount',
    0.7,
  );
  expect(applied.get('echo.amount')).toBe(0.7);
  expect(applied.get('reverb.mix')).toBe(0.2);
  expect(applied.get('delay.ms')).toBe(320);
});

it('retries a rejected parameter while retaining the independently acknowledged values', async () => {
  const { port, applied } = fixture();
  const failure = new Error('DSP unavailable');
  let rejected = false;
  port.setDspParameter.mockImplementation(async (name, value) => {
    if (name === 'reverb.mix' && !rejected) {
      rejected = true;
      throw failure;
    }
    applied.set(name, value);
  });

  await expect(applyVoiceChain(settings, port)).rejects.toBe(failure);
  expect(port.setDspParameter).toHaveBeenCalledTimes(9);
  expect(applied.size).toBe(8);
  expect(port.setDspEnabled).not.toHaveBeenCalled();
  port.setDspParameter.mockClear();

  await applyVoiceChain(settings, port);

  expect(port.setDspParameter).toHaveBeenCalledExactlyOnceWith(
    'reverb.mix',
    0.2,
  );
  expect(applied.size).toBe(9);
  expect(port.setDspEnabled).toHaveBeenCalledExactlyOnceWith(true);
});

it('reapplies the previous value after a changed parameter is rejected', async () => {
  const { port, applied } = fixture();
  await applyVoiceChain(settings, port);
  const failure = new Error('DSP acknowledgement unavailable');
  port.setDspParameter.mockImplementationOnce(async (name, value) => {
    // A lost acknowledgement does not establish which value native accepted.
    applied.set(name, value);
    throw failure;
  });
  await expect(
    applyVoiceChain(
      {
        ...settings,
        karaokeEffects: { ...settings.karaokeEffects, echo: 0.9 },
      },
      port,
    ),
  ).rejects.toBe(failure);
  port.setDspParameter.mockClear();

  await applyVoiceChain(settings, port);

  expect(port.setDspParameter).toHaveBeenCalledExactlyOnceWith(
    'echo.amount',
    0.1,
  );
  expect(applied.get('echo.amount')).toBe(0.1);
});

it('fully initializes an independent audio port with the same settings', async () => {
  const first = fixture();
  await applyVoiceChain(settings, first.port);
  const second = fixture();
  await applyVoiceChain(settings, second.port);

  expect(second.port.setDspParameter).toHaveBeenCalledTimes(9);
  expect(second.applied).toEqual(first.applied);
  expect(second.port.setDspEnabled).toHaveBeenCalledExactlyOnceWith(true);
});

it('replays remembered parameters after native restart and reconfiguration before continuing differential updates', async () => {
  const applied = new Map<string, number>();
  let enabled = false;
  let state = 'Running';
  let instance = 1;
  let rejectNextEcho = false;
  const { requests } = installBridge(({ command, args }) => {
    if (command === 'SetDspParameter') {
      if (rejectNextEcho && args?.name === 'echo.amount') {
        rejectNextEcho = false;
        return { status: 7, text: 'DSP unavailable' };
      }
      applied.set(String(args?.name), Number(args?.value));
    }
    if (command === 'SetDspEnabled') enabled = Boolean(args?.enabled);
    if (command === 'Reconfigure') {
      applied.clear();
      enabled = false;
      state = 'Prepared';
    }
    if (command === 'StartSession') state = 'Running';
    return {
      status: 0,
      text:
        command === 'GetServiceState'
          ? 'Running'
          : ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(command)
            ? `SessionState: ${state}\nServiceInstanceId: voice-${instance}\nBackend: WASAPI Shared\nRuntimeOutputSampleRate: 48000`
            : 'Ok',
    };
  });
  const configuration = {
    backend: 'WASAPI Shared' as const,
    sampleRate: 48000,
    periodFrames: 256,
  };
  audioClient.setPreferredConfiguration(configuration);
  try {
    await applyVoiceChain(settings, audioClient);
    expect(applied.size).toBe(9);
    const expected = new Map(applied);

    rejectNextEcho = true;
    await expect(
      applyVoiceChain(
        {
          ...settings,
          karaokeEffects: { ...settings.karaokeEffects, echo: 0.9 },
        },
        audioClient,
      ),
    ).rejects.toThrow('DSP unavailable');
    // Reverting also repairs audioClient's remembered value for the next restart.
    await applyVoiceChain(settings, audioClient);

    applied.clear();
    enabled = false;
    state = 'Idle';
    instance++;
    expect(await audioClient.health()).toMatchObject({ status: 'ready' });
    expect(applied).toEqual(expected);
    expect(enabled).toBe(true);
    requests.length = 0;
    await applyVoiceChain({ ...settings, voiceGain: 1.5 }, audioClient);
    expect(
      requests.filter(({ command }) => command === 'SetDspParameter'),
    ).toHaveLength(0);
    expect(applied).toEqual(expected);

    await audioClient.applyConfiguration(configuration);
    expect(applied).toEqual(expected);
    expect(enabled).toBe(true);
    requests.length = 0;
    await applyVoiceChain(
      {
        ...settings,
        karaokeEffects: { ...settings.karaokeEffects, echo: 0.8 },
      },
      audioClient,
    );
    expect(
      requests.filter(({ command }) => command === 'SetDspParameter'),
    ).toEqual([
      {
        command: 'SetDspParameter',
        args: { name: 'echo.amount', value: 0.8 },
      },
    ]);
    expected.set('echo.amount', 0.8);
    expect(applied).toEqual(expected);
  } finally {
    Reflect.deleteProperty(window, 'desktop');
  }
});
