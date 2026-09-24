import { useCallback, useEffect, useRef, useState } from "react";
import { audioClient, getAudioSnapshot } from "../../services/audioClient";

const pollMilliseconds = 100;

export const useEditorPreview = (audioReady: boolean, onFailure: () => void) => {
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const playingRef = useRef(playing);
  playingRef.current = playing;

  useEffect(() => {
    if (!audioReady) return;
    const timer = window.setInterval(() => {
      void getAudioSnapshot()
        .then(snapshot => {
          setPosition(snapshot.positionSeconds);
          if (snapshot.state === "finished" || snapshot.state === "ready") setPlaying(false);
        })
        .catch(() => setPlaying(false));
    }, pollMilliseconds);
    return () => window.clearInterval(timer);
  }, [audioReady]);

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
