import { audioClient } from "../../services/audioClient";

/** Releases every live karaoke audio path before the route disappears. */
export const releaseKaraokeAudio = async (): Promise<void> => {
  await audioClient.setMonitoring(false).catch(() => undefined);
  await audioClient.setDspEnabled(false).catch(() => undefined);
  await audioClient.stop().catch(() => undefined);
};
