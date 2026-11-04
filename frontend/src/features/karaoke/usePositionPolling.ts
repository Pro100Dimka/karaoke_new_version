import { audioClient as audio, invalidateAudioSnapshots } from '../../services/audioClient';
import { useCallback, useEffect, useRef } from 'react';
import type { PlaybackSnapshot } from '../../contracts/models';

interface PositionPollingOptions {
  enabled: boolean;
  /** Updates are applied only while the session has a meaningful position. */
  isPollable(): boolean;
  isPlaying(): boolean;
  onPosition(seconds: number): void;
  onSnapshot?(snapshot: PlaybackSnapshot): void;
  onFinished(): void;
  onLost(): void;
}

interface PositionPollingHandle {
  /** Discards pending notifications around a seek, preserving the new authoritative position. */
  invalidate(): void;
}

/** Authoritative position comes from AudioService; the renderer never simulates a clock. */
export const usePositionPolling = (
  options: PositionPollingOptions,
): PositionPollingHandle => {
  const callbacks = useRef(options);
  callbacks.current = options;
  const { enabled } = options;
  const playing = options.isPlaying();

  useEffect(() => {
    if (!enabled) return;
    return audio.observeSnapshots((snapshot) => {
      const current = callbacks.current;
      if (!current.isPollable()) return;
      current.onSnapshot?.(snapshot);
      current.onPosition(snapshot.positionSeconds);
      if (snapshot.state === 'finished' && current.isPlaying()) current.onFinished();
    }, () => {
      if (callbacks.current.isPollable()) callbacks.current.onLost();
    }, playing ? 16 : 500);
  }, [enabled, playing]);

  const invalidate = useCallback(() => {
    invalidateAudioSnapshots();
  }, []);

  return { invalidate };
};
