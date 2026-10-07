import { useCallback, useEffect, useRef, useState } from "react";
import type { RecordingDto } from "../../contracts/models";
import { useRecordingPreview } from "../../app/LibraryProvider";

const pollMilliseconds = 100;

/**
 * Playback of one take through AudioService. Only one take is loaded at a time: when another player loads its own take,
 * this one notices (the loaded id differs) and falls back to idle.
 */
export const useRecordingPlayback = (recording: RecordingDto) => {
  const preview = useRecordingPreview();
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const owns = useRef(false);
  const polling = useRef(false);
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
        await preview.pauseRecordingPreview();
        setPlaying(false);
        return;
      }
      await preview.playRecording(id);
      owns.current = true;
      if (pendingSeek.current !== null) {
        await preview.seekRecordingPreview(pendingSeek.current);
        pendingSeek.current = null;
      }
      setPlaying(true);
    } catch {
      release();
    }
  }, [id, playing, release, preview]);

  const seek = useCallback(async (seconds: number) => {
    setPosition(seconds);
    if (!owns.current) {
      pendingSeek.current = seconds;
      return;
    }
    await preview.seekRecordingPreview(seconds).catch(() => undefined);
  }, [preview]);

  useEffect(() => {
    if (!playing) return;
    let active = true;
    const timer = window.setInterval(() => {
      if (polling.current) return;
      polling.current = true;
      void preview
        .recordingPreviewStatus()
        .then((status) => {
          if (!active) return;
          if (status.recordingId !== id || status.state === "finished")
            release();
          else setPosition(status.positionSeconds);
        })
        .catch(() => {
          if (active) release();
        })
        .finally(() => {
          polling.current = false;
        });
    }, pollMilliseconds);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [playing, id, release, preview]);

  useEffect(
    () => () => {
      if (owns.current)
        void preview.stopRecordingPreview().catch(() => undefined);
    },
    [preview],
  );

  return { playing, position, toggle, seek };
};
