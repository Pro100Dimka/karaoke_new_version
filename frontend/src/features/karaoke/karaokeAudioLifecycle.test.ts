import { beforeEach, describe, expect, it, vi } from "vitest";
import { audioClient } from "../../services/audioClient";
import { releaseKaraokeAudio } from "./karaokeAudioLifecycle";
import { recordingCoordinator } from "../../services/recordingCoordinator";

vi.mock("../../services/recordingCoordinator", () => ({ recordingCoordinator: { stop: vi.fn(async () => undefined) } }));

vi.mock("../../services/audioClient", () => ({
  audioClient: {
    setMonitoring: vi.fn(async () => ({ monitoring: false })),
    setDspEnabled: vi.fn(async () => undefined),
    setMixer: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined)
  }
}));

describe("releaseKaraokeAudio", () => {
  beforeEach(() => vi.clearAllMocks());

  it("turns monitoring off but keeps the singer's own voice effects, which belong to the whole app", async () => {
    await releaseKaraokeAudio();
    expect(recordingCoordinator.stop).toHaveBeenCalledOnce();
    expect(audioClient.setMonitoring).toHaveBeenCalledWith(false);
    expect(audioClient.setDspEnabled).not.toHaveBeenCalled();
    expect(audioClient.stop).toHaveBeenCalledOnce();
  });

  it("restores full master volume so the karaoke master never quietens radio or previews", async () => {
    await releaseKaraokeAudio();
    expect(audioClient.setMixer).toHaveBeenCalledWith("master", 1);
  });

  it("dispatches route shutdown before delayed recording registration can outlive the next route", async () => {
    let finish!: () => void;
    const pending = new Promise<{ recording: boolean }>(resolve => { finish = () => resolve({ recording: false }); });
    vi.mocked(recordingCoordinator.stop).mockReturnValueOnce(pending);
    const releasing = releaseKaraokeAudio();
    expect(audioClient.stop).toHaveBeenCalledOnce();
    expect(audioClient.setMonitoring).toHaveBeenCalledWith(false);
    vi.clearAllMocks();
    finish();
    await releasing;
    expect(audioClient.stop).not.toHaveBeenCalled();
    expect(audioClient.setMonitoring).not.toHaveBeenCalled();
  });
});
