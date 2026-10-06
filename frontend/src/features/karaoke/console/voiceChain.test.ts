import { beforeEach, describe, expect, it, vi } from "vitest";
import { audioClient } from "../../../services/audioClient";
import { applyVoiceChain } from "./voiceChain";

vi.mock("../../../services/audioClient", () => ({
  audioClient: {
    setMixer: vi.fn(async () => undefined),
    setDspParameter: vi.fn(async () => undefined),
    setDspEnabled: vi.fn(async () => undefined),
  },
}));

describe("applyVoiceChain", () => {
  beforeEach(() => vi.clearAllMocks());

  it("plays the stored microphone volume, effects and noise suppression exactly", async () => {
    await applyVoiceChain({
      voiceGain: 0.68,
      karaokeEffects: { echo: 0.12, reverb: 0.42, delay: 0.08, autoTune: 0.5 },
      noiseSuppression: 0.4,
    });
    expect(audioClient.setMixer).toHaveBeenCalledWith("mic", 0.68);
    expect(audioClient.setDspParameter).toHaveBeenCalledWith("delay.mix", 0.12);
    expect(audioClient.setDspParameter).toHaveBeenCalledWith(
      "reverb.mix",
      0.42,
    );
    expect(audioClient.setDspParameter).toHaveBeenCalledWith("delay.ms", 40);
    expect(audioClient.setDspParameter).toHaveBeenCalledWith(
      "autotune.amount",
      0.5,
    );
    expect(audioClient.setDspParameter).toHaveBeenCalledWith(
      "noise.threshold",
      0.012,
    );
    expect(audioClient.setDspEnabled).toHaveBeenCalledWith(true);
  });

  it("switches the effect chain off when nothing audible is set", async () => {
    await applyVoiceChain({
      voiceGain: 1,
      karaokeEffects: { echo: 0, reverb: 0, delay: 0.24, autoTune: 0 },
      noiseSuppression: 0,
    });
    expect(audioClient.setDspEnabled).toHaveBeenCalledWith(false);
  });
});
