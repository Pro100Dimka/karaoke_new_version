import { reportOperationFailure, clearOperationFailure } from '../errors';
import { useEffect, useState } from 'react';
import { desktopClient } from '../../services/desktopClient';

/** Peaks for a waveform, reloaded when `key` changes; null while loading or when they cannot be read. */
const usePeaks = (
  load: (requestId: string) => Promise<readonly number[]>,
  key: string,
): readonly number[] | null => {
  const [peaks, setPeaks] = useState<readonly number[] | null>(null);

  useEffect(() => {
    let active = true;
    setPeaks(null);
    if (!key) return;
    const requestId = crypto.randomUUID();
    let pending = true;
    load(requestId)
      .then((values) => {
        pending = false;
        if (active) {
          clearOperationFailure('errors.waveform');
          setPeaks(values.length > 0 ? values : null);
        }
      })
      .catch((error: unknown) => {
        pending = false;
        if (active) {
          setPeaks(null);
          reportOperationFailure('errors.waveform', error);
        }
      });
    return () => {
      active = false;
      if (pending)
        void desktopClient.cancelWaveform(requestId).catch(() => undefined);
    };
    // `key` identifies what `load` reads; a new closure for the same source must not reload it.
  }, [key]);

  return peaks;
};

/** The song's instrumental, for the seek waveform. */
export const useWaveformPeaks = (
  songId: string,
  revision: number,
  enabled = true,
): readonly number[] | null =>
  usePeaks(
    (requestId) =>
      desktopClient.waveformPeaks(songId, revision, 480, requestId),
    enabled ? `${songId}:${revision}` : '',
  );

/** A saved take, for its player's waveform. */
export const useRecordingPeaks = (
  recordingId: string,
  original = false,
): readonly number[] | null =>
  usePeaks(
    (requestId) =>
      original
        ? desktopClient.waveformPeaks(recordingId, 0, 240, requestId)
        : desktopClient.recordingPeaks(recordingId, 240, requestId),
    `${original ? 'song' : 'recording'}:${recordingId}`,
  );
