import { observeOperation } from '../../shared/errors';
import { audioClient } from '../../services/audioClient';
import { useCallback, useEffect, useRef, useState } from 'react';
import { observable, runInAction } from 'mobx';

export const useEditorPreview = (
  audioReady: boolean,
  onFailure: () => void,
) => {
  const [playing, setPlaying] = useState(false);
  const [position] = useState(() => observable.box(0));
  const playingRef = useRef(playing);
  playingRef.current = playing;

  useEffect(() => {
    if (!audioReady) {
      setPlaying(false);
      return;
    }
    if (!playing) return;
    return audioClient.observeSnapshots(
      (snapshot) => {
        runInAction(() => position.set(snapshot.positionSeconds));
        if (['finished', 'ready'].includes(snapshot.state)) setPlaying(false);
      },
      () => {
        setPlaying(false);
        onFailure();
      },
    );
  }, [audioReady, playing, onFailure, position]);

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

  const seek = useCallback(
    async (seconds: number) => {
      const snapshot = await observeOperation(
        'errors.seek',
        audioClient.seek(seconds),
      ).catch(() => null);
      if (snapshot) runInAction(() => position.set(snapshot.positionSeconds));
    },
    [position],
  );

  return {
    playing,
    get position() {
      return position.get();
    },
    togglePlay,
    seek,
  };
};
