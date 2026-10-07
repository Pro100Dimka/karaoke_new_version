import { useEffect, useRef, type MutableRefObject } from "react";
import type { SongDto } from "../../contracts/models";
import { useKaraokeAudio } from "../../app/KaraokeProvider";
import { recoverKaraokeAudio } from "../../application/karaoke/KaraokeRecovery";

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
export const useAudioRecovery = ({
  recovering,
  song,
  position,
  speed,
  key,
  onRecovered,
}: AudioRecoveryOptions): void => {
  const audioClient = useKaraokeAudio();
  const inFlight = useRef(false);
  useEffect(() => {
    if (!recovering) return;
    let active = true;
    const timer = window.setInterval(() => {
      if (inFlight.current) return;
      inFlight.current = true;
      void (async () => {
        try {
          if (await recoverKaraokeAudio({
            audio: audioClient,
            song: song.current,
            position: position.current,
            speed: speed.current,
            key: key.current,
            isCurrent: () => active,
          })) onRecovered();
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
