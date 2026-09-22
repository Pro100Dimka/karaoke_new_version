import { beforeEach, describe, expect, it, vi } from "vitest";
import { audioClient } from "../../services/audioClient";
import { releaseKaraokeAudio } from "./karaokeAudioLifecycle";

vi.mock("../../services/audioClient", () => ({
  audioClient: {
    setMonitoring: vi.fn(async () => ({ monitoring: false })),
    setDspEnabled: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined)
  }
}));

describe("releaseKaraokeAudio", () => {
  beforeEach(() => vi.clearAllMocks());

  it("turns monitoring and voice processing off before leaving karaoke", async () => {
    await releaseKaraokeAudio();
    expect(audioClient.setMonitoring).toHaveBeenCalledWith(false);
    expect(audioClient.setDspEnabled).toHaveBeenCalledWith(false);
    expect(audioClient.stop).toHaveBeenCalledOnce();
  });
});
