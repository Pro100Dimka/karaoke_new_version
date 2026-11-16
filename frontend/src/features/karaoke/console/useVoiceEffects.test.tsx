import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useVoiceEffects } from './useVoiceEffects';
import { useInputMonitoring } from '../../../pages/library/modals/settings/audio/useInputMonitoring';
import type { PlaybackSnapshot } from '../../../contracts/models';

const monitoring = vi.hoisted(() => ({
  snapshot: vi.fn(async () => ({ monitoring: false })),
  setMonitoring: vi.fn(async () => undefined),
  observeSnapshots: vi.fn<(onValue: (value: Pick<PlaybackSnapshot, 'inputLevel' | 'monitoringSafetyTripped'>) => void) => () => void>(() => () => {}),
  notify: vi.fn(),
}));
vi.mock('../../../services/audioClient', () => ({ audioClient: {
  ...monitoring, setMixer: vi.fn(async () => undefined), setDspParameter: vi.fn(async () => undefined),
  setDspEnabled: vi.fn(async () => undefined),
} }));
vi.mock('../../../providers/notifications', () => ({ useNotify: () => monitoring.notify }));
vi.mock('../../../pages/library/modals/settings/audio/audioSession', () => ({
  audioSessionFor: () => ({ enqueue: (work: () => unknown) => Promise.resolve().then(work), refresh: async () => {} }),
}));
import {
  effectFromKnob,
  effectToKnob,
  voiceEffects,
  type VoiceEffectValues,
} from './voiceEffects';

describe('useVoiceEffects', () => {
  it.each([[false, false], [true, false], [true, true]] as const)(
    'restores prior monitoring=%s after the input test, unless safety trips=%s', async (enabled, safety) => {
      monitoring.snapshot.mockResolvedValue({ monitoring: enabled });
      monitoring.setMonitoring.mockClear();
      monitoring.observeSnapshots.mockClear();
      const hook = renderHook(() => useInputMonitoring(true));
      try {
        act(() => hook.result.current.setTestingInput(true));
        await waitFor(() => expect(monitoring.observeSnapshots).toHaveBeenCalledOnce());
        if (safety) act(() => monitoring.observeSnapshots.mock.calls[0]?.[0]({ inputLevel: 0, monitoringSafetyTripped: true }));
        else act(() => hook.result.current.setTestingInput(false));
        await waitFor(() => expect(monitoring.setMonitoring).toHaveBeenCalledTimes(2));
        expect(monitoring.setMonitoring).toHaveBeenLastCalledWith(enabled && !safety);
      } finally {
        hook.unmount();
      }
    },
  );
  it('lets the delay knob reach zero and stores zero without a minimum offset', () => {
    expect(voiceEffects.find((effect) => effect.id === 'delay')?.min).toBe(0);
    const store = vi.fn();
    const { result } = renderHook(() =>
      useVoiceEffects(
        { echo: 0.2, reverb: 0, delay: 0.02, autoTune: 0 },
        store,
      ),
    );
    act(() => result.current.change('delay', effectFromKnob(0)));
    expect(store).toHaveBeenLastCalledWith({
      echo: 0.2,
      reverb: 0,
      delay: 0,
      autoTune: 0,
    });
  });

  it('keeps stored DSP amounts while the knob uses its nonlinear scale', () => {
    const saved: VoiceEffectValues = {
      echo: 0.21,
      reverb: 0.43,
      delay: 0.16,
      autoTune: 0.5,
    };
    const store = vi.fn();
    const { result } = renderHook(() => useVoiceEffects(saved, store));

    expect(result.current.values).toEqual(saved);
    expect(effectToKnob(0.125)).toBe(0.5);
    expect(effectFromKnob(1)).toBe(1);
    act(() => result.current.change('reverb', effectFromKnob(0.6)));

    expect(store).toHaveBeenLastCalledWith({
      ...saved,
      reverb: expect.closeTo(0.216, 12),
    });
  });

  it("stores a preset's echo, reverb and delay together and marks it chosen", () => {
    const saved: VoiceEffectValues = {
      echo: 0,
      reverb: 0.25,
      delay: 0.08,
      autoTune: 0.3,
    };
    const store = vi.fn();
    const { result } = renderHook(() => useVoiceEffects(saved, store));

    act(() =>
      result.current.applyPreset({
        id: 'room',
        label: 'presetRoom',
        symbol: '◇',
        echo: 0.12,
        reverb: 0.42,
        delay: 0.08,
      }),
    );

    expect(store).toHaveBeenLastCalledWith({
      echo: 0.12,
      reverb: 0.42,
      delay: 0.08,
      autoTune: 0.3,
    });
    expect(result.current.preset).toBe('room');
    expect(effectFromKnob(effectToKnob(0.42))).toBeCloseTo(0.42, 12);
  });
});
