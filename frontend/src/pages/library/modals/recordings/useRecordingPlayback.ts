import {
  observeOperation,
  reportOperationFailure,
  clearOperationFailure,
  toAppError,
} from '../../../../shared/errors';
import { audioClient as preview } from '../../../../services/audioClient';
import { recordingsChanged } from '../../../../services/backendEvents';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RecordingDto } from '../../../../contracts/models';

/**
 * Playback of one take through AudioService. Only one take is loaded at a time: when another player loads its own take,
 * this one notices the lost ownership and falls back to idle.
 */
export const useRecordingPlayback = (
  recording: Pick<RecordingDto, 'id' | 'fileStatus'>,
  original = false,
) => {
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [volume, setVolume] = useState(1);
  const [fileMissing, setFileMissing] = useState(recording.fileStatus === 'Missing');
  const owns = useRef(false);
  const loading = useRef(false);
  const owner = useRef(Symbol('recording-preview'));
  const generation = useRef(0);
  const pendingSeek = useRef<number | null>(null);
  const seeking = useRef<Promise<void> | null>(null);
  const lastPosition = useRef(0);
  const id = recording.id;

  const release = useCallback(() => {
    generation.current += 1;
    owns.current = false;
    loading.current = false;
    pendingSeek.current = null;
    seeking.current = null;
    lastPosition.current = 0;
    setPlaying(false);
    setPosition(0);
  }, []);

  const toggle = useCallback(async () => {
    // A pause/play is a barrier: finish the latest requested position first.
    const previous = generation.current;
    if (seeking.current) {
      await seeking.current;
      if (previous !== generation.current) return;
    }
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
      while (pendingSeek.current !== null) {
        const target = pendingSeek.current;
        pendingSeek.current = null;
        await preview.seekRecordingPreview(target, owner.current);
        if (request !== generation.current) return;
        lastPosition.current = target;
      }
      loading.current = false;
      clearOperationFailure('errors.previewPlayback');
      setFileMissing(false);
      setPlaying(true);
      if (fileMissing) recordingsChanged();
    } catch (error) {
      if (request === generation.current) {
        void preview.stopRecordingPreview(owner.current).catch(() => undefined);
        release();
        if (toAppError(error).code === 'RecordingFileMissing') {
          setFileMissing(true);
          if (!fileMissing) recordingsChanged();
        } else reportOperationFailure('errors.previewPlayback', error);
      }
    } finally {
      if (request === generation.current) loading.current = false;
    }
  }, [id, original, playing, fileMissing, release, preview, volume]);

  const changeVolume = (value: number) => {
    setVolume(value);
    if (owns.current)
      void observeOperation(
        'errors.previewVolume',
        preview.setPreviewVolume(value, owner.current),
      ).catch(() => undefined);
  };

  const seek = useCallback(
    (seconds: number): Promise<void> => {
      // Paint immediately, but keep at most one native operation and one newer target.
      setPosition(seconds);
      pendingSeek.current = seconds;
      if (!owns.current || loading.current) return Promise.resolve();
      if (seeking.current) return seeking.current;
      const request = generation.current;
      const drain = async () => {
        try {
          while (
            request === generation.current &&
            pendingSeek.current !== null
          ) {
            const status = await preview.recordingPreviewStatus(owner.current);
            if (request !== generation.current) return;
            if (!status || status.recordingId !== id) {
              owns.current = false;
              setPlaying(false);
              return;
            }
            const target = pendingSeek.current;
            pendingSeek.current = null;
            await preview.seekRecordingPreview(target, owner.current);
            if (request !== generation.current) return;
            lastPosition.current = target;
            clearOperationFailure('errors.previewSeek');
          }
        } catch (error) {
          if (request === generation.current) {
            pendingSeek.current = null;
            setPosition(lastPosition.current);
            reportOperationFailure('errors.previewSeek', error);
          }
        }
      };
      const work = drain().finally(() => {
        if (seeking.current === work) seeking.current = null;
      });
      seeking.current = work;
      return work;
    },
    [id, preview],
  );

  useEffect(() => {
    if (!playing) return;
    return preview.observeRecordingPreview(
      owner.current,
      (status) => {
        if (status.recordingId !== id || status.state === 'finished') release();
        else if (!seeking.current && pendingSeek.current === null) {
          lastPosition.current = status.positionSeconds;
          setPosition(status.positionSeconds);
        }
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
      pendingSeek.current = null;
      seeking.current = null;
      if (owns.current) {
        owns.current = false;
        void preview.stopRecordingPreview(owner.current).catch(() => undefined);
      }
    };
  }, [id, original, preview, release]);

  return { playing, position, toggle, seek, volume, changeVolume, fileMissing };
};
