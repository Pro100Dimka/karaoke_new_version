import { useCallback, useEffect, useRef, useState } from "react";
import { audioClient, getAudioSnapshot } from "../../services/audioClient";

const pollMilliseconds = 100;

export const useEditorPreview = (
  audioReady: boolean,
  onFailure: () => void,
) => {
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const playingRef = useRef(playing);
  const inFlight = useRef(false);
  playingRef.current = playing;

  useEffect(() => {
    if (!audioReady || !playing) return;
    let active = true;
    const timer = window.setInterval(() => {
      if (inFlight.current) return;
      inFlight.current = true;
      void getAudioSnapshot()
        .then((snapshot) => {
          if (!active) return;
          setPosition(snapshot.positionSeconds);
          if (snapshot.state === "finished" || snapshot.state === "ready")
            setPlaying(false);
        })
        .catch(() => { if (active) setPlaying(false); })
        .finally(() => { inFlight.current = false; });
    }, pollMilliseconds);
    return () => { active = false; window.clearInterval(timer); };
  }, [audioReady, playing]);

  const togglePlay = useCallback(async () => {
    if (!audioReady) return;
    try {
      if (playingRef.current) {
        await audioClient.pause();
        setPlaying(false);
      } else {
        await audioClient.play();
        setPlaying(true);
      }
    } catch {
      onFailure();
    }
  }, [audioReady, onFailure]);

  const seek = useCallback(async (seconds: number) => {
    setPosition(seconds);
    await audioClient.seek(seconds).catch(() => undefined);
  }, []);

  return { playing, position, togglePlay, seek };
};
