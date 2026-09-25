import { beforeEach, describe, expect, it, vi } from "vitest";
import { audioClient } from "../../services/audioClient";
import { releaseKaraokeAudio } from "./karaokeAudioLifecycle";
import { recordingCoordinator } from "../../services/recordingCoordinator";

vi.mock("../../services/recordingCoordinator", () => ({ recordingCoordinator: { stop: vi.fn(async () => undefined) } }));

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
    expect(recordingCoordinator.stop).toHaveBeenCalledOnce();
    expect(audioClient.setMonitoring).toHaveBeenCalledWith(false);
    expect(audioClient.setDspEnabled).toHaveBeenCalledWith(false);
    expect(audioClient.stop).toHaveBeenCalledOnce();
  });

  it("dispatches route shutdown before delayed recording registration can outlive the next route", async () => {
    let finish!: () => void;
    const pending = new Promise<{ recording: boolean }>(resolve => { finish = () => resolve({ recording: false }); });
    vi.mocked(recordingCoordinator.stop).mockReturnValueOnce(pending);
    const releasing = releaseKaraokeAudio();
    expect(audioClient.stop).toHaveBeenCalledOnce();
    expect(audioClient.setMonitoring).toHaveBeenCalledWith(false);
    expect(audioClient.setDspEnabled).toHaveBeenCalledWith(false);
    vi.clearAllMocks();
    finish();
    await releasing;
    expect(audioClient.stop).not.toHaveBeenCalled();
    expect(audioClient.setMonitoring).not.toHaveBeenCalled();
  });
});
