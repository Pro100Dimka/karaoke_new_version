import { audioClient } from '../../services/audioClient';
import { useEffect, type MutableRefObject } from 'react';
import type { SongDto } from '../../contracts/models';
import { recoverKaraokeAudio } from '../../application/karaoke/KaraokeRecovery';

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
  useEffect(() => {
    if (!recovering) return;
    let active = true;
    let inFlight = false;
    const timer = window.setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      const recoveringSong = song.current;
      const recoveringSpeed = speed.current;
      const recoveringKey = key.current;
      const isCurrent = () =>
        active &&
        song.current === recoveringSong &&
        speed.current === recoveringSpeed &&
        key.current === recoveringKey;
      void (async () => {
        try {
          if (
            (await recoverKaraokeAudio({
              audio: audioClient,
              song: recoveringSong,
              position: position.current,
              speed: recoveringSpeed,
              key: recoveringKey,
              isCurrent,
            })) &&
            isCurrent()
          )
            onRecovered();
        } catch {
          // Keep retrying until AudioService accepts the session again.
        } finally {
          inFlight = false;
        }
      })();
    }, recoveryPollMilliseconds);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [recovering, song, position, speed, key, onRecovered]);
};
