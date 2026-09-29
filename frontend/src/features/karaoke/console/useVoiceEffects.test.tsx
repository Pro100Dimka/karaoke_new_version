import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useVoiceEffects } from "./useVoiceEffects";
import { type VoiceEffectValues } from "./voiceEffects";

describe("useVoiceEffects", () => {
  it("shows the stored knob values and reports every change for storing", () => {
    const saved: VoiceEffectValues = { echo: 0.21, reverb: 0.43, delay: 0.16, autoTune: 0.5 };
    const store = vi.fn();
    const { result } = renderHook(() => useVoiceEffects(saved, store));

    expect(result.current.values).toEqual(saved);
    act(() => result.current.change("reverb", 0.61));

    expect(store).toHaveBeenLastCalledWith({ ...saved, reverb: 0.61 });
  });

  it("stores a preset's echo, reverb and delay together and marks it chosen", () => {
    const saved: VoiceEffectValues = { echo: 0, reverb: 0.25, delay: 0.08, autoTune: 0.3 };
    const store = vi.fn();
    const { result } = renderHook(() => useVoiceEffects(saved, store));

    act(() => result.current.applyPreset({ id: "room", label: "presetRoom", symbol: "◇", echo: 0.12, reverb: 0.42, delay: 0.08 }));

    expect(store).toHaveBeenLastCalledWith({ echo: 0.12, reverb: 0.42, delay: 0.08, autoTune: 0.3 });
    expect(result.current.preset).toBe("room");
  });
});
