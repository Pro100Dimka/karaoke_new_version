import { useEffect, useRef, type MutableRefObject } from "react";
import type { SongDto } from "../../contracts/models";
import { audioClient } from "../../services/audioClient";

const recoveryPollMilliseconds = 1000;

interface AudioRecoveryOptions {
  recovering: boolean;
  song: MutableRefObject<SongDto | null>;
  position: MutableRefObject<number>;
  speed: MutableRefObject<number>;
  key: MutableRefObject<number>;
  onRecovered(): void;
}

/** Restores the AudioService session and position after an outage; it never resumes playback. */
export const useAudioRecovery = ({ recovering, song, position, speed, key, onRecovered }: AudioRecoveryOptions): void => {
  const inFlight = useRef(false);
  useEffect(() => {
    if (!recovering) return;
    let active = true;
    const timer = window.setInterval(() => {
      if (inFlight.current) return;
      inFlight.current = true;
      void (async () => {
        try {
          const target = song.current;
          if (!target || (await audioClient.health()).status !== "ready" || !active) return;
          await audioClient.prepareSong(target);
          if (!active) return;
          await audioClient.setPlaybackRate(speed.current);
          if (!active) return;
          await audioClient.setPitchShift(key.current);
          if (!active) return;
          await audioClient.seek(position.current);
          if (active) onRecovered();
        } catch {
          // Keep retrying until AudioService accepts the session again.
        } finally {
          inFlight.current = false;
        }
      })();
    }, recoveryPollMilliseconds);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [recovering, song, position, speed, key, onRecovered]);
};
