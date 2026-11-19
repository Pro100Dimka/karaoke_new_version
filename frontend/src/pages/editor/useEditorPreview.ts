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
  const generation = useRef(0);
  const pendingToggle = useRef<number | null>(null);

  useEffect(() => {
    generation.current += 1;
    pendingToggle.current = null;
    playingRef.current = false;
    setPlaying(false);
    runInAction(() => position.set(0));
    return () => {
      generation.current += 1;
    };
  }, [audioReady, position]);

  useEffect(() => {
    if (!audioReady || !playing) return;
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
    if (!audioReady || pendingToggle.current !== null) return;
    const request = generation.current;
    pendingToggle.current = request;
    const nextPlaying = !playingRef.current;
    try {
      await (nextPlaying ? audioClient.play() : audioClient.pause());
      if (request === generation.current) {
        playingRef.current = nextPlaying;
        setPlaying(nextPlaying);
      }
    } catch {
      if (request === generation.current) onFailure();
    } finally {
      if (pendingToggle.current === request) pendingToggle.current = null;
    }
  }, [audioReady, onFailure]);

  const seek = useCallback(
    async (seconds: number) => {
      if (!audioReady) return;
      const request = generation.current;
      const snapshot = await observeOperation(
        'errors.seek',
        audioClient.seek(seconds),
      ).catch(() => null);
      if (snapshot && request === generation.current)
        runInAction(() => position.set(snapshot.positionSeconds));
    },
    [audioReady, position],
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
