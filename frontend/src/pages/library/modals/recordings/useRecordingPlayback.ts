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
export const useRecordingPlayback = (
  recording: Pick<RecordingDto, 'id'>,
  original = false,
) => {
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [volume, setVolume] = useState(1);
  const owns = useRef(false);
  const loading = useRef(false);
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
      loading.current = true;
      await preview[original ? 'playSongPreview' : 'playRecording'](
        id,
        owner.current,
        volume,
      );
      if (request !== generation.current) return;
      loading.current = false;
      if (pendingSeek.current !== null) {
        await preview.seekRecordingPreview(pendingSeek.current, owner.current);
        if (request !== generation.current) return;
        pendingSeek.current = null;
      }
      clearOperationFailure('errors.previewPlayback');
      setPlaying(true);
    } catch (error) {
      if (request === generation.current) {
        void preview.stopRecordingPreview(owner.current).catch(() => undefined);
        release();
        reportOperationFailure('errors.previewPlayback', error);
      }
    } finally {
      if (request === generation.current) loading.current = false;
    }
  }, [id, original, playing, release, preview, volume]);

  const changeVolume = (value: number) => {
    setVolume(value);
    if (owns.current)
      void observeOperation(
        'errors.previewVolume',
        preview.setPreviewVolume(value, owner.current),
      ).catch(() => undefined);
  };

  const seek = useCallback(
    async (seconds: number) => {
      const request = generation.current;
      try {
        const status =
          owns.current && !loading.current
            ? await preview.recordingPreviewStatus(owner.current)
            : null;
        if (request !== generation.current) return;
        if (!status || status.recordingId !== id) {
          if (!loading.current) owns.current = false;
          setPlaying(false);
          setPosition(seconds);
          pendingSeek.current = seconds;
          return;
        }
        await preview.seekRecordingPreview(seconds, owner.current);
        if (request === generation.current) {
          clearOperationFailure('errors.previewSeek');
          setPosition(seconds);
        }
      } catch (error) {
        if (request === generation.current)
          reportOperationFailure('errors.previewSeek', error);
      }
    },
    [id, preview],
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
      loading.current = false;
      if (owns.current) {
        owns.current = false;
        void preview.stopRecordingPreview(owner.current).catch(() => undefined);
      }
    };
  }, [id, original, preview, release]);

  return { playing, position, toggle, seek, volume, changeVolume };
};
