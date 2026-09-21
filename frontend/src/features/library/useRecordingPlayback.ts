import { useCallback, useEffect, useRef, useState } from "react";
import type { RecordingDto } from "../../contracts/models";
import { audioClient } from "../../services/audioClient";

const pollMilliseconds = 100;

/**
 * Playback of one take through AudioService. Only one take is loaded at a time: when another player loads its own take,
 * this one notices (the loaded id differs) and falls back to idle.
 */
export const useRecordingPlayback = (recording: RecordingDto) => {
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const owns = useRef(false);
  const pendingSeek = useRef<number | null>(null);
  const id = recording.id;

  const release = useCallback(() => {
    owns.current = false;
    setPlaying(false);
    setPosition(0);
  }, []);

  const toggle = useCallback(async () => {
    try {
      if (owns.current && playing) {
        await audioClient.pauseRecordingPreview();
        setPlaying(false);
        return;
      }
      await audioClient.playRecording(id);
      owns.current = true;
      if (pendingSeek.current !== null) {
        await audioClient.seekRecordingPreview(pendingSeek.current);
        pendingSeek.current = null;
      }
      setPlaying(true);
    } catch {
      release();
    }
  }, [id, playing, release]);

  const seek = useCallback(
    async (seconds: number) => {
      setPosition(seconds);
      if (!owns.current) {
        pendingSeek.current = seconds;
        return;
      }
      await audioClient.seekRecordingPreview(seconds).catch(() => undefined);
    },
    []
  );

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      void audioClient
        .recordingPreviewStatus()
        .then(status => {
          if (status.recordingId !== id || status.state === "finished") release();
          else setPosition(status.positionSeconds);
        })
        .catch(release);
    }, pollMilliseconds);
    return () => window.clearInterval(timer);
  }, [playing, id, release]);

  useEffect(
    () => () => {
      if (owns.current) void audioClient.stopRecordingPreview().catch(() => undefined);
    },
    []
  );

  return { playing, position, toggle, seek };
};
