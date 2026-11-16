import { useCallback, useRef, useState, type MutableRefObject } from 'react';
import { tr } from '@neo-ui-kit/react';
import { useNotify } from '../../providers/notifications';
import { ask } from '../../providers/dialog';
import { openSettings } from '../../pages/library/modals/settings';
import { store } from '../../providers/store';
import { audioClient } from '../../services/audioClient';
import { pythonClient } from '../../services/pythonClient';
import { recordingCoordinator } from '../../services/recordingCoordinator';
import { KaraokeRecordingCoordinator } from '../../application/karaoke/KaraokeRecordingCoordinator';
import type { reduceKaraoke } from '../../application/karaoke/karaokeMachine';
import type { RoomStateDto, SongDto } from '../../contracts/models';
import type { useRoomPlayback } from '../../providers/application';
import { askInsufficientDisk } from './askInsufficientDisk';
import { createSingleFlight } from './performanceFinish';
type RecordingUiState =
  'idle' | 'starting' | 'recording' | 'stopping' | 'failed';
export const useKaraokeRecording = ({
  room,
  roomPlayback,
  dispatch,
  playbackGeneration,
  songRef,
  positionRef,
  speedRef,
  keyRef,
}: {
  room: RoomStateDto | null;
  roomPlayback: ReturnType<typeof useRoomPlayback>;
  dispatch(event: Parameters<typeof reduceKaraoke>[1]): void;
  playbackGeneration: MutableRefObject<number>;
  songRef: MutableRefObject<SongDto | null>;
  positionRef: MutableRefObject<number>;
  speedRef: MutableRefObject<number>;
  keyRef: MutableRefObject<number>;
}) => {
  const notify = useNotify();
  const recordingWorkRef = useRef<KaraokeRecordingCoordinator>(null);
  recordingWorkRef.current ??= new KaraokeRecordingCoordinator(
    pythonClient,
    recordingCoordinator,
    audioClient,
  );
  const recordingWork = recordingWorkRef.current;
  const [recording, setRecording] = useState<RecordingUiState>('idle');
  const [recordingId, setRecordingId] = useState<string | undefined>();
  const recordingRef = useRef(recording);
  recordingRef.current = recording;
  const finishLocalWork = useCallback(async () => {
    playbackGeneration.current++;
    dispatch({ type: 'STOPPING' });
    setRecording('stopping');
    const result = await recordingWork.finish(roomPlayback?.finalPerformance());
    if (result.recordingId) {
      setRecordingId(result.recordingId);
      notify(tr('recordingSaved'), 'success');
    }
    if (!result.saved) {
      store.cancelPlaylist();
      setRecording('failed');
      notify(tr('recordingFailed'), 'error');
    }
    if (result.saved && room?.playlist && room.performanceId !== undefined) {
      try {
        await roomPlayback?.advancePlaylist(room.performanceId);
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), 'error');
      }
    }
    setRecording((current) => (current === 'failed' ? current : 'idle'));
    dispatch({ type: 'FINISH' });
    return result.saved;
  }, [notify, recordingWork, roomPlayback, room]);
  const finishLocalWorkRef = useRef(finishLocalWork);
  finishLocalWorkRef.current = finishLocalWork;
  const finishLocalPerformanceRef = useRef<() => Promise<boolean>>(undefined);
  finishLocalPerformanceRef.current ??= createSingleFlight(() =>
    finishLocalWorkRef.current(),
  );
  const finishLocalPerformance = finishLocalPerformanceRef.current;
  const startRecording = useCallback(async () => {
    const target = songRef.current;
    if (!target) return false;
    recordingRef.current = 'starting';
    setRecording('starting');
    const result = await recordingWork.start(target, {
      sourceSeconds: positionRef.current,
      playbackRate: speedRef.current,
      keyShift: keyRef.current,
    });
    if (result.kind === 'cancelled') return false;
    recordingRef.current = result.kind === 'started' ? 'recording' : 'failed';
    if (result.kind === 'insufficientDisk') {
      setRecording('failed');
      const choice = await askInsufficientDisk(ask, result.free);
      if (recordingWork.isCurrent(result.generation) && choice === 'storage')
        openSettings('advanced');
      return false;
    }
    if (result.kind === 'started') setRecording('recording');
    else {
      setRecording('failed');
      notify(tr('recordingFailed'), 'error');
    }
    return result.kind === 'started';
  }, [ask, notify, openSettings, recordingWork]);
  return {
    recordingWork,
    recording,
    setRecording,
    recordingRef,
    recordingId,
    finishLocalPerformance,
    startRecording,
  };
};
