import { useEffect, useState } from "react";
import { desktopClient } from "../../../services/desktopClient";

const bins = 480;

/** Peaks of the song's instrumental for the seek waveform; null while loading or when they cannot be read. */
export const useWaveformPeaks = (songId: string, revision: number): readonly number[] | null => {
  const [peaks, setPeaks] = useState<readonly number[] | null>(null);

  useEffect(() => {
    let active = true;
    setPeaks(null);
    desktopClient
      .waveformPeaks(songId, revision, bins)
      .then(values => active && setPeaks(values.length > 0 ? values : null))
      .catch(() => active && setPeaks(null));
    return () => {
      active = false;
    };
  }, [songId, revision]);

  return peaks;
};
