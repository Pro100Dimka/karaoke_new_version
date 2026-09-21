import { useEffect } from "react";
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

/** Authoritative position comes from AudioService; the renderer never simulates a clock. */
export const usePositionPolling = ({ enabled, isPollable, isPlaying, onPosition, onFinished, onLost }: PositionPollingOptions): void => {
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      if (!isPollable()) return;
      void getAudioSnapshot()
        .then(snapshot => {
          onPosition(snapshot.positionSeconds);
          if (snapshot.state === "finished" && isPlaying()) onFinished();
        })
        .catch(onLost);
    }, pollMilliseconds);
    return () => window.clearInterval(timer);
  }, [enabled, isPollable, isPlaying, onPosition, onFinished, onLost]);
};
