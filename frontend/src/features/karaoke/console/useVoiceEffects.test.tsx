import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { audioClient } from "../../../services/audioClient";
import { useVoiceEffects } from "./useVoiceEffects";
import type { VoiceEffectValues } from "./voiceEffects";

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
    const saved: VoiceEffectValues = { echo: 0.21, reverb: 0.43, delay: 0.16 };
    const persist = vi.fn();
    const { result } = renderHook(() => useVoiceEffects(0, true, false, saved, persist));

    expect(result.current.values).toEqual(saved);
    await act(() => result.current.change("reverb", 0.61));

    expect(persist).toHaveBeenLastCalledWith({ ...saved, reverb: 0.61 });
  });
});
