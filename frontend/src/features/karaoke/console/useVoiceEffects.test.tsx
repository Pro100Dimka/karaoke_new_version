import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { audioClient } from "../../../services/audioClient";
import { useVoiceEffects } from "./useVoiceEffects";
import { autoTuneScaleMask, type VoiceEffectValues } from "./voiceEffects";

vi.mock("../../../services/audioClient", () => ({
  audioClient: { setDspParameter: vi.fn(async () => undefined), setDspEnabled: vi.fn(async () => undefined) }
}));

describe("useVoiceEffects", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reapplies the displayed effect values when monitoring is switched on", async () => {
    const { result, rerender } = renderHook(
      ({ monitoring }) => useVoiceEffects(0.4, true, monitoring),
      { initialProps: { monitoring: false } }
    );
    await act(() => result.current.applyPreset({ id: "room", label: "presetRoom", symbol: "◇", echo: 0.12, reverb: 0.42, delay: 0.08 }));
    vi.clearAllMocks();

    rerender({ monitoring: true });

    await waitFor(() => expect(audioClient.setDspParameter).toHaveBeenCalledWith("delay.mix", 0.12));
    expect(audioClient.setDspParameter).toHaveBeenCalledWith("reverb.mix", 0.42);
    expect(audioClient.setDspParameter).toHaveBeenCalledWith("delay.ms", 40);
    expect(audioClient.setDspParameter).toHaveBeenCalledWith("noise.threshold", 0.012);
    expect(audioClient.setDspEnabled).toHaveBeenCalledWith(true);
  });

  it("starts from saved knob values and reports every change for persistence", async () => {
    const saved: VoiceEffectValues = { echo: 0.21, reverb: 0.43, delay: 0.16, autoTune: 0.5 };
    const persist = vi.fn();
    const { result } = renderHook(() => useVoiceEffects(0, true, false, saved, persist));

    expect(result.current.values).toEqual(saved);
    await act(() => result.current.change("reverb", 0.61));

    expect(persist).toHaveBeenLastCalledWith({ ...saved, reverb: 0.61 });
  });

  it("changes delay independently without changing a silent echo", async () => {
    const initial: VoiceEffectValues = { echo: 0, reverb: 0.25, delay: 0.08, autoTune: 0 };
    const persist = vi.fn();
    const { result } = renderHook(() => useVoiceEffects(0, true, false, initial, persist));

    await act(() => result.current.change("delay", 0.24));

    expect(result.current.values).toEqual({ ...initial, delay: 0.24 });
    expect(persist).toHaveBeenLastCalledWith({ ...initial, delay: 0.24 });
  });

  it("enables native smooth auto-tune without pushing pitch jumps from UI measurements", async () => {
    const values: VoiceEffectValues = { echo: 0, reverb: 0, delay: 0.24, autoTune: 0.5 };
    const slightlySharpA = 440 * 2 ** (0.4 / 12);

    const scaleMask = autoTuneScaleMask([{ pitch: 57 }, { pitch: 60 }, { pitch: 64 }]);
    renderHook(() => useVoiceEffects(0, true, false, values, undefined, slightlySharpA, scaleMask));

    await waitFor(() => expect(audioClient.setDspParameter)
      .toHaveBeenCalledWith("autotune.amount", 0.5));
    expect(audioClient.setDspParameter).toHaveBeenCalledWith("autotune.scaleMask", scaleMask);
    expect(audioClient.setDspParameter)
      .not.toHaveBeenCalledWith("pitch.semitones", expect.anything());
    expect(audioClient.setDspEnabled).toHaveBeenCalledWith(true);
  });

  it("derives the allowed auto-tune scale from the song's actual reference notes", () => {
    expect(autoTuneScaleMask([{ pitch: 57 }, { pitch: 60 }, { pitch: 64 }, { pitch: 69 }]))
      .toBe((1 << 9) | (1 << 0) | (1 << 4));
    expect(autoTuneScaleMask([])).toBe(0xfff);
  });
});
