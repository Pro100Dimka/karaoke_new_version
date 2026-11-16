import { beforeEach, describe, expect, it, vi } from 'vitest';
import { audioClient } from '../../../services/audioClient';
import { applyVoiceChain } from './voiceChain';

vi.mock('../../../services/audioClient', () => ({
  audioClient: {
    setMixer: vi.fn(async () => undefined),
    setDspParameter: vi.fn(async () => undefined),
    setDspEnabled: vi.fn(async () => undefined),
  },
}));

describe('applyVoiceChain', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps the latest chain when an earlier microphone command finishes late', async () => {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const applied = new Map<string, number>();
    const port = {
      setMixer: vi.fn(async (_target: string, gain: number) => {
        if (gain === 0.5) await blocked;
      }),
      setDspParameter: vi.fn(async (name: string, value: number) => {
        applied.set(name, value);
      }),
      setDspEnabled: vi.fn(async () => undefined),
    };
    const settings = {
      voiceGain: 0.5,
      karaokeEffects: { echo: 0, reverb: 0, delay: 0, autoTune: 0 },
      noiseSuppression: 0,
    };
    const first = applyVoiceChain(settings, port);
    await vi.waitFor(() => expect(port.setMixer).toHaveBeenCalled());
    const last = applyVoiceChain(
      {
        ...settings,
        voiceGain: 1,
        karaokeEffects: { ...settings.karaokeEffects, echo: 0.7 },
      },
      port,
    );
    await Promise.resolve();
    release();
    await Promise.all([first, last]);
    expect(applied.get('echo.amount')).toBe(0.7);
    expect(port.setDspEnabled).toHaveBeenLastCalledWith(true);
    expect(port.setMixer).toHaveBeenLastCalledWith('mic', 1);
  });

  it('drains all older DSP writes after a failure before applying newer settings', async () => {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let echo = 0;
    const failure = new Error('DSP unavailable');
    const port = {
      setMixer: vi.fn(async () => undefined),
      setDspParameter: vi.fn(async (name: string, value: number) => {
        if (name === 'echo.amount') {
          if (value === 0.1) await blocked;
          echo = value;
        }
        if (name === 'reverb.mix' && value === 0.1) throw failure;
      }),
      setDspEnabled: vi.fn(async () => undefined),
    };
    const settings = {
      voiceGain: 1,
      karaokeEffects: { echo: 0.1, reverb: 0.1, delay: 0, autoTune: 0 },
      noiseSuppression: 0,
    };
    const first = applyVoiceChain(settings, port).catch(
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(port.setDspParameter).toHaveBeenCalled());
    const last = applyVoiceChain(
      {
        ...settings,
        karaokeEffects: { ...settings.karaokeEffects, echo: 0.8, reverb: 0 },
      },
      port,
    );
    await vi.waitFor(() => expect(port.setMixer).toHaveBeenCalled());
    await Promise.resolve();
    release();
    expect(await first).toBe(failure);
    await last;
    expect(echo).toBe(0.8);
    expect(port.setDspEnabled).toHaveBeenLastCalledWith(true);
  });

  it('plays the stored microphone volume, effects and noise suppression exactly', async () => {
    await applyVoiceChain(
      {
        voiceGain: 0.68,
        karaokeEffects: {
          echo: 0.12,
          reverb: 0.42,
          delay: 0.08,
          autoTune: 0.5,
        },
        noiseSuppression: 0.4,
      },
      audioClient,
    );
    expect(audioClient.setMixer).toHaveBeenCalledWith('mic', 0.68);
    expect(audioClient.setDspParameter).toHaveBeenCalledWith(
      'echo.amount',
      0.12,
    );
    expect(audioClient.setDspParameter).toHaveBeenCalledWith(
      'reverb.mix',
      0.42,
    );
    expect(audioClient.setDspParameter).toHaveBeenCalledWith(
      'delay.mix',
      expect.closeTo(0.044),
    );
    expect(audioClient.setDspParameter).toHaveBeenCalledWith('delay.ms', 320);
    expect(audioClient.setDspParameter).toHaveBeenCalledWith(
      'autotune.amount',
      0.5,
    );
    expect(audioClient.setDspParameter).toHaveBeenCalledWith(
      'noise.threshold',
      0.012,
    );
    expect(audioClient.setDspEnabled).toHaveBeenCalledWith(true);
  });

  it('switches the effect chain off when nothing audible is set', async () => {
    await applyVoiceChain(
      {
        voiceGain: 1,
        karaokeEffects: { echo: 0, reverb: 0, delay: 0, autoTune: 0 },
        noiseSuppression: 0,
      },
      audioClient,
    );
    expect(audioClient.setDspEnabled).toHaveBeenCalledWith(false);
  });

  it.each(['echo', 'delay'] as const)(
    'enables %s with every other effect off',
    async (effect) => {
      await applyVoiceChain(
        {
          voiceGain: 1,
          karaokeEffects: {
            echo: 0,
            reverb: 0,
            delay: 0,
            autoTune: 0,
            [effect]: 0.5,
          },
          noiseSuppression: 0,
        },
        audioClient,
      );
      expect(audioClient.setDspEnabled).toHaveBeenCalledWith(true);
    },
  );
});
