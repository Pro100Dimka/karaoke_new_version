import { useEffect, type MutableRefObject } from "react";
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
  useEffect(() => {
    if (!recovering) return;
    let active = true;
    const timer = window.setInterval(() => {
      void (async () => {
        const target = song.current;
        if (!target || (await audioClient.health()).status !== "ready") return;
        try {
          await audioClient.prepareSong(target);
          await audioClient.setPlaybackRate(speed.current);
          await audioClient.setPitchShift(key.current);
          await audioClient.seek(position.current);
          if (active) onRecovered();
        } catch {
          // Keep retrying until AudioService accepts the session again.
        }
      })();
    }, recoveryPollMilliseconds);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [recovering, song, position, speed, key, onRecovered]);
};
