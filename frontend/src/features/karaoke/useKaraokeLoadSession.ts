import {
  reportOperationFailure,
  clearOperationFailure,
  observeOperation,
} from '../../shared/errors';
import { store } from '../../providers/store';
import { editorApi } from '../../pages/editor/editorApi';
import { audioClient } from '../../services/audioClient';
import { pythonClient } from '../../services/pythonClient';
import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  AudioCapabilities,
  MixerChannelGains,
} from '../../contracts/models';
import type { EditorDocument } from '../../application/editor/editorModel';
import type { SongPreferences } from '../../application/library/songPreferences';
import type { KaraokeLoad } from '../../application/karaoke/karaokeLoader';
import { prepareKaraokeSession } from '../../application/karaoke/KaraokePreparation';
import type { KaraokeOpenMode } from './useKaraokeSession';

const noMicrophone: AudioCapabilities = {
  microphone: 'missing',
  keyboardLighting: false,
};

export const useKaraokeLoadSession = (
  songId: string,
  reloadKey: KaraokeOpenMode,
  gains: MixerChannelGains,
  onPrepared: () => void,
  onFailure: (error: unknown) => void,
  onRestart: () => void = () => undefined,
) => {
  const { pythonEpoch, audioEpoch } = store.application.services;
  const audioConfiguration = store.preferences.audio;
  const preparedSession = useRef('');
  const [load, setLoad] = useState<KaraokeLoad>({ kind: 'loading' });
  const [document, setDocument] = useState<EditorDocument | null>(null);
  const [songPrefs, setSongPrefs] = useState<SongPreferences | null>(null);
  const [capabilities, setCapabilities] =
    useState<AudioCapabilities>(noMicrophone);
  const capabilityRequest = useRef(0);
  // Device recovery and an explicit settings change do not reload the song.
  const refreshCapabilities = useCallback(async () => {
    const request = ++capabilityRequest.current;
    const current = await observeOperation(
      'errors.microphoneCapabilities',
      audioClient.capabilities(),
    ).catch(() => noMicrophone);
    if (request !== capabilityRequest.current) return noMicrophone;
    setCapabilities(current);
    return current;
  }, []);
  const audioContext = useRef({ audioEpoch, audioConfiguration });
  useEffect(() => {
    const previous = audioContext.current;
    audioContext.current = { audioEpoch, audioConfiguration };
    if (
      previous.audioEpoch !== audioEpoch ||
      previous.audioConfiguration !== audioConfiguration
    )
      void refreshCapabilities();
  }, [audioEpoch, audioConfiguration, refreshCapabilities]);
  useEffect(
    () => () => {
      capabilityRequest.current++;
    },
    [],
  );

  useEffect(() => {
    let active = true;
    const key = JSON.stringify([songId, reloadKey]);
    if (preparedSession.current === key) {
      void pythonClient
        .getSong(songId)
        .then((song) => {
          if (active)
            setLoad((current) =>
              current.kind === 'ready' && current.song.id === songId
                ? {
                    ...current,
                    song: {
                      ...current.song,
                      artworkUrl: song.artworkUrl,
                      videoUrl: song.videoUrl,
                    },
                  }
                : current,
            );
        })
        .then(() => {
          if (active) clearOperationFailure('errors.songRefresh');
        })
        .catch((error: unknown) => {
          if (active) reportOperationFailure('errors.songRefresh', error);
        });
      return () => {
        active = false;
      };
    }
    preparedSession.current = '';
    setLoad({ kind: 'loading' });
    setDocument(null);
    setSongPrefs(null);
    onRestart();
    const initialCapabilityRequest = capabilityRequest.current;
    void prepareKaraokeSession({
      songId,
      gains,
      backend: pythonClient,
      repository: editorApi,
      audio: audioClient,
      isCurrent: () => active,
      onResolved: (resolved) => {
        setLoad(resolved.load);
        setSongPrefs(resolved.prefs);
      },
      onDocument: setDocument,
      onCapabilities: (value) => {
        if (initialCapabilityRequest === capabilityRequest.current)
          setCapabilities(value);
      },
      onPrepared: () => {
        preparedSession.current = key;
        onPrepared();
      },
      onFailure,
    }).catch((error) => {
      if (active) onFailure(error);
    });
    return () => {
      active = false;
    };
  }, [songId, reloadKey, pythonEpoch]); // callbacks and opening gains intentionally belong to this one session

  return { load, document, songPrefs, capabilities, refreshCapabilities };
};
