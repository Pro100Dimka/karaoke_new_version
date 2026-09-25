import { useCallback, useEffect, useRef } from "react";
import type { PlaybackSnapshot } from "../../contracts/models";
import { getAudioSnapshot } from "../../services/audioClient";

const pollMilliseconds = 100;

interface PositionPollingOptions {
  enabled: boolean;
  /** Polling only runs while the session is in a state that has a meaningful position. */
  isPollable(): boolean;
  isPlaying(): boolean;
  onPosition(seconds: number): void;
  onSnapshot?(snapshot: PlaybackSnapshot): void;
  onFinished(): void;
  onLost(): void;
}

export interface PositionPollingHandle {
  /** Drops the reply of every poll issued so far, even ones already in flight. Call this around a seek:
   * a poll started just before the seek can still resolve just after it, with the pre-seek position --
   * applying that reply would flash the highlight, piano roll and scene video back a moment. */
  invalidate(): void;
}

/** Authoritative position comes from AudioService; the renderer never simulates a clock. */
export const usePositionPolling = (options: PositionPollingOptions): PositionPollingHandle => {
  // Persists across effect re-runs and outlives each in-flight request, so invalidate() reaches every
  // request issued by this hook instance, not just the current effect run's own closure.
  const latestSequence = useRef(0);
  const inFlight = useRef(false);
  const callbacks = useRef(options);
  callbacks.current = options;
  const { enabled } = options;

  useEffect(() => {
    if (!enabled) return;
    // Keep slow IPC from accumulating polls or starving replies behind ever-newer requests.
    const timer = window.setInterval(() => {
      if (inFlight.current || !callbacks.current.isPollable()) return;
      inFlight.current = true;
      const sequence = ++latestSequence.current;
      void getAudioSnapshot()
        .then(snapshot => {
          if (sequence !== latestSequence.current) return;
          const current = callbacks.current;
          current.onSnapshot?.(snapshot);
          current.onPosition(snapshot.positionSeconds);
          if (snapshot.state === "finished" && current.isPlaying()) current.onFinished();
        })
        .catch(() => {
          if (sequence === latestSequence.current) callbacks.current.onLost();
        })
        .finally(() => {
          inFlight.current = false;
        });
    }, pollMilliseconds);
    return () => {
      window.clearInterval(timer);
      latestSequence.current += 1;
    };
  }, [enabled]);

  const invalidate = useCallback(() => {
    latestSequence.current += 1;
  }, []);

  return { invalidate };
};
