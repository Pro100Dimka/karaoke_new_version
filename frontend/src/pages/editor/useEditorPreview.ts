import { observeOperation } from '../../shared/errors';
import { audioClient } from '../../services/audioClient';
import { useCallback, useEffect, useRef, useState } from 'react';
import { observable, runInAction } from 'mobx';
import type { PlaybackSnapshot } from '../../contracts/models';

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
  const seekRevision = useRef(0);
  const pendingSeek = useRef<number | null>(null);
  const confirmedPosition = useRef(0);
  const seekOwner = useRef<() => boolean>(() => false);

  useEffect(() => {
    const request = ++generation.current;
    // A stable owner lets the native queue merge adjacent seeks in this session.
    seekOwner.current = () => request === generation.current;
    pendingToggle.current = null;
    pendingSeek.current = null;
    if (!audioReady) {
      confirmedPosition.current = 0;
      playingRef.current = false;
      setPlaying(false);
      runInAction(() => position.set(0));
    }
    return () => {
      generation.current += 1;
    };
  }, [audioReady, position]);

  useEffect(() => {
    if (!audioReady || !playing) return;
    return audioClient.observeSnapshots(
      (snapshot) => {
        confirmedPosition.current = snapshot.positionSeconds;
        if (pendingSeek.current === null)
          runInAction(() => position.set(snapshot.positionSeconds));
        if (['finished', 'ready'].includes(snapshot.state)) {
          playingRef.current = false;
          setPlaying(false);
        }
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
      const seekRequest = ++seekRevision.current;
      pendingSeek.current = seekRequest;
      // Only the explicit gesture is optimistic; native acknowledgements resume
      // the clock, and failed seeks return to the last confirmed position.
      runInAction(() => position.set(seconds));
      const snapshot = await observeOperation(
        'errors.seek',
        audioClient.seek(seconds, seekOwner.current),
      ).catch(() => null);
      if (request !== generation.current) return;
      if (snapshot) confirmedPosition.current = snapshot.positionSeconds;
      if (pendingSeek.current !== seekRequest) return;
      pendingSeek.current = null;
      if (snapshot) {
        playingRef.current = snapshot.state === 'playing';
        setPlaying(playingRef.current);
      }
      runInAction(() => position.set(confirmedPosition.current));
    },
    [audioReady, position],
  );

  const restore = useCallback(
    (snapshot: PlaybackSnapshot) => {
      playingRef.current = snapshot.state === 'playing';
      setPlaying(playingRef.current);
      confirmedPosition.current = snapshot.positionSeconds;
      if (pendingSeek.current === null)
        runInAction(() => position.set(snapshot.positionSeconds));
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
    restore,
  };
};
