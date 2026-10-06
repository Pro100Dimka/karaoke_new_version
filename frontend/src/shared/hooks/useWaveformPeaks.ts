import { useEffect, useState } from "react";
import { desktopClient } from "../../services/desktopClient";

/** Peaks for a waveform, reloaded when `key` changes; null while loading or when they cannot be read. */
const usePeaks = (
  load: () => Promise<readonly number[]>,
  key: string,
): readonly number[] | null => {
  const [peaks, setPeaks] = useState<readonly number[] | null>(null);

  useEffect(() => {
    let active = true;
    setPeaks(null);
    load()
      .then((values) => active && setPeaks(values.length > 0 ? values : null))
      .catch(() => active && setPeaks(null));
    return () => {
      active = false;
    };
    // `key` identifies what `load` reads; a new closure for the same source must not reload it.
  }, [key]);

  return peaks;
};

/** The song's instrumental, for the seek waveform. */
export const useWaveformPeaks = (
  songId: string,
  revision: number,
): readonly number[] | null =>
  usePeaks(
    () => desktopClient.waveformPeaks(songId, revision, 480),
    `${songId}:${revision}`,
  );

/** A saved take, for its player's waveform. */
export const useRecordingPeaks = (
  recordingId: string,
): readonly number[] | null =>
  usePeaks(() => desktopClient.recordingPeaks(recordingId, 240), recordingId);
