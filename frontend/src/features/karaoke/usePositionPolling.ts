import { useCallback, useEffect, useRef } from "react";
import { getAudioSnapshot } from "../../services/audioClient";

const pollMilliseconds = 100;

interface PositionPollingOptions {
  enabled: boolean;
  /** Polling only runs while the session is in a state that has a meaningful position. */
  isPollable(): boolean;
  isPlaying(): boolean;
  onPosition(seconds: number): void;
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
export const usePositionPolling = ({
  enabled,
  isPollable,
  isPlaying,
  onPosition,
  onFinished,
  onLost
}: PositionPollingOptions): PositionPollingHandle => {
  // Persists across effect re-runs and outlives each in-flight request, so invalidate() reaches every
  // request issued by this hook instance, not just the current effect run's own closure.
  const latestSequence = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    // Each round trip crosses IPC and a named pipe, so a later poll can occasionally resolve before an
    // earlier one; applying replies out of arrival order would flash the highlight back to a stale
    // position. Only the latest issued request's reply is ever applied.
    const timer = window.setInterval(() => {
      if (!isPollable()) return;
      const sequence = ++latestSequence.current;
      void getAudioSnapshot()
        .then(snapshot => {
          if (sequence !== latestSequence.current) return;
          onPosition(snapshot.positionSeconds);
          if (snapshot.state === "finished" && isPlaying()) onFinished();
        })
        .catch(() => {
          if (sequence === latestSequence.current) onLost();
        });
    }, pollMilliseconds);
    return () => window.clearInterval(timer);
  }, [enabled, isPollable, isPlaying, onPosition, onFinished, onLost]);

  const invalidate = useCallback(() => {
    latestSequence.current += 1;
  }, []);

  return { invalidate };
};
