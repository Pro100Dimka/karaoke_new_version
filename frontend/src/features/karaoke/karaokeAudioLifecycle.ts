import { audioClient } from "../../services/audioClient";
import { recordingCoordinator } from "../../services/recordingCoordinator";

/** Releases every live karaoke audio path before the route disappears. */
export const releaseKaraokeAudio = async (): Promise<void> => {
  // Queue the old route's audio commands now; saving its recording may outlive the next route.
  await Promise.allSettled([
    recordingCoordinator.stop(),
    audioClient.setMonitoring(false),
    audioClient.setDspEnabled(false),
    audioClient.stop(),
  ]);
};
