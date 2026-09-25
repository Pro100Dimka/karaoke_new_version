import { audioClient } from "../../services/audioClient";
import { recordingCoordinator } from "../../services/recordingCoordinator";

/** Releases every live karaoke audio path before the route disappears. */
export const releaseKaraokeAudio = async (): Promise<void> => {
  await recordingCoordinator.stop().catch(() => undefined);
  await audioClient.setMonitoring(false).catch(() => undefined);
  await audioClient.setDspEnabled(false).catch(() => undefined);
  await audioClient.stop().catch(() => undefined);
};
