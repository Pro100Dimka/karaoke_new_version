import {
  observeOperation,
  reportOperationFailure,
  clearOperationFailure,
} from '../../../../shared/errors';
import { audioClient as preview } from '../../../../services/audioClient';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RecordingDto } from '../../../../contracts/models';

/**
 * Playback of one take through AudioService. Only one take is loaded at a time: when another player loads its own take,
 * this one notices the lost ownership and falls back to idle.
 */
export const useRecordingPlayback = (recording: RecordingDto) => {
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const owns = useRef(false);
  const owner = useRef(Symbol('recording-preview'));
  const generation = useRef(0);
  const pendingSeek = useRef<number | null>(null);
  const id = recording.id;

  const release = useCallback(() => {
    owns.current = false;
    setPlaying(false);
    setPosition(0);
  }, []);

  const toggle = useCallback(async () => {
    const request = ++generation.current;
    try {
      if (owns.current && playing) {
        await preview.pauseRecordingPreview(owner.current);
        if (request === generation.current) setPlaying(false);
        return;
      }
      owns.current = true;
      await preview.playRecording(id, owner.current);
      if (request !== generation.current) return;
      if (pendingSeek.current !== null) {
        await preview.seekRecordingPreview(pendingSeek.current, owner.current);
        if (request !== generation.current) return;
        pendingSeek.current = null;
      }
      clearOperationFailure('errors.previewPlayback');
      setPlaying(true);
    } catch (error) {
      if (request === generation.current) {
        release();
        reportOperationFailure('errors.previewPlayback', error);
      }
    }
  }, [id, playing, release, preview]);

  const seek = useCallback(
    async (seconds: number) => {
      if (!owns.current) {
        setPosition(seconds);
        pendingSeek.current = seconds;
        return;
      }
      await observeOperation(
        'errors.previewSeek',
        preview.seekRecordingPreview(seconds, owner.current),
      ).then(
        () => setPosition(seconds),
        () => undefined,
      );
    },
    [preview],
  );

  useEffect(() => {
    if (!playing) return;
    return preview.observeRecordingPreview(
      owner.current,
      (status) => {
        if (status.recordingId !== id || status.state === 'finished') release();
        else setPosition(status.positionSeconds);
      },
      (error) => {
        release();
        reportOperationFailure('errors.previewPlayback', error);
      },
    );
  }, [playing, id, release, preview]);

  useEffect(() => {
    release();
    pendingSeek.current = null;
    return () => {
      generation.current += 1;
      if (owns.current) {
        owns.current = false;
        void preview.stopRecordingPreview(owner.current).catch(() => undefined);
      }
    };
  }, [id, preview, release]);

  return { playing, position, toggle, seek };
};
