import { useEffect, useState } from "react";
import { desktopClient } from "../../services/desktopClient";

const bins = 240;

/** Peaks of a saved take for its waveform; null while loading or when the file cannot be read. */
export const useRecordingPeaks = (recordingId: string): readonly number[] | null => {
  const [peaks, setPeaks] = useState<readonly number[] | null>(null);

  useEffect(() => {
    let active = true;
    setPeaks(null);
    desktopClient
      .recordingPeaks(recordingId, bins)
      .then(values => active && setPeaks(values.length > 0 ? values : null))
      .catch(() => active && setPeaks(null));
    return () => {
      active = false;
    };
  }, [recordingId]);

  return peaks;
};
