import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useVoiceEffects } from './useVoiceEffects';
import {
  effectFromKnob,
  effectToKnob,
  voiceEffects,
  type VoiceEffectValues,
} from './voiceEffects';

describe('useVoiceEffects', () => {
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
