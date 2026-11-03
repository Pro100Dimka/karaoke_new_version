import { observeOperation } from '../../shared/errors';
import { store } from '../../providers/store';
import { useLocale } from '@neo-ui-kit/react';
import { monitoringErrorText } from '../../shared/errors';
import { audioClient } from '../../services/audioClient';
import { recordingCoordinator } from '../../services/recordingCoordinator';
import { canControlRoom } from '../../application/room/roomModel';
import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { useRoomPlayback } from '../../providers/application';
import type { MixerChannelGains } from '../../contracts/models';
import { useNotify } from '../../providers/notifications';
import { sharedStateOf } from '../../application/room/roomModel';
import type { Preferences } from '../../shared/preferences/preferences';

/** Stored preference for every mixer channel, so a change is kept for the next session. */
const gainPreferences = {
  music: 'musicGain',
  mic: 'voiceGain',
  reference: 'referenceGain',
  melody: 'melodyGain',
  master: 'masterGain',
} as const satisfies Record<keyof MixerChannelGains, keyof Preferences>;
interface KaraokeControlsOptions {
  position: MutableRefObject<number>;
  speed: MutableRefObject<number>;
  key: MutableRefObject<number>;
  monitoring: boolean;
  ready?: boolean;
  microphoneReady: boolean;
  setPosition: Dispatch<SetStateAction<number>>;
  setSpeed: Dispatch<SetStateAction<number>>;
  setKeyShift: Dispatch<SetStateAction<number>>;
  setGains: Dispatch<SetStateAction<MixerChannelGains>>;
  setMonitoring: Dispatch<SetStateAction<boolean>>;
}

/** Transport-adjacent controls; tempo and key belong only to the active karaoke session. */
export const useKaraokeControls = ({
  position,
  speed,
  key,
  monitoring,
  ready = false,
  microphoneReady,
  setPosition,
  setSpeed,
  setKeyShift,
  setGains,
  setMonitoring,
}: KaraokeControlsOptions) => {
  const notify = useNotify();
  useLocale();
  const { preferences, updatePreferences } = store;
  const { room } = store.online;
  const roomPlayback = useRoomPlayback();

  const publishPracticeParameters = useCallback(
    async (playbackRate: number, keyShift: number) => {
      if (
        !room ||
        !roomPlayback ||
        !canControlRoom(room) ||
        room.playbackLocked
      )
        return false;
      const updated = await observeOperation(
        'errors.practice',
        roomPlayback.updateSharedState({
          ...sharedStateOf(room),
          playbackRate,
          keyShift,
        }),
      ).catch(() => null);
      if (!updated) return false;
      return true;
    },
    [room, roomPlayback],
  );

  const seek = useCallback(
    async (seconds: number) => {
      if (room) {
        if (!roomPlayback || !canControlRoom(room)) return;
        await observeOperation(
          'errors.seek',
          roomPlayback.control('Seek', seconds),
        ).catch(() => null);
        return;
      }
      const snapshot = await observeOperation(
        'errors.seek',
        audioClient.seek(seconds),
      ).catch(() => null);
      if (!snapshot) return;
      position.current = snapshot.positionSeconds;
      setPosition(snapshot.positionSeconds);
    },
    [position, room, roomPlayback, setPosition],
  );

  const changeSpeed = useCallback(
    async (value: number) => {
      if (room && !(await publishPracticeParameters(value, key.current)))
        return;
      const applied = await observeOperation(
        'errors.tempo',
        audioClient.setPlaybackRate(value),
      ).then(
        () => true,
        () => false,
      );
      if (!applied) return;
      speed.current = value;
      setSpeed(value);
      recordingCoordinator.updatePlaybackAdjustment({
        sourceSeconds: position.current,
        playbackRate: value,
        keyShift: key.current,
      });
    },
    [key, position, publishPracticeParameters, room, setSpeed, speed],
  );

  const changeKey = useCallback(
    async (delta: number) => {
      const next = Math.max(-12, Math.min(12, key.current + delta));
      if (room && !(await publishPracticeParameters(speed.current, next)))
        return;
      const applied = await observeOperation(
        'errors.pitch',
        audioClient.setPitchShift(next),
      ).then(
        () => true,
        () => false,
      );
      if (!applied) return;
      key.current = next;
      setKeyShift(next);
      recordingCoordinator.updatePlaybackAdjustment({
        sourceSeconds: position.current,
        playbackRate: speed.current,
        keyShift: next,
      });
    },
    [key, position, publishPracticeParameters, room, setKeyShift, speed],
  );

  const changeGain = useCallback(
    async (channel: keyof MixerChannelGains, value: number) => {
      if (channel !== 'mic') {
        const applied = await observeOperation(
          'errors.mixer',
          audioClient.setMixer(channel, value),
        ).then(
          () => true,
          () => false,
        );
        if (!applied) return;
      }
      setGains((current) => ({ ...current, [channel]: value }));
      updatePreferences({ [gainPreferences[channel]]: value });
    },
    [setGains, updatePreferences],
  );

  const monitoringChange = useRef<{ id: number; pending: boolean | null }>({
    id: 0,
    pending: null,
  });
  const toggleMonitoring = useCallback(async () => {
    if (!microphoneReady) return;
    const id = ++monitoringChange.current.id;
    const enabled = !(monitoringChange.current.pending ?? monitoring);
    monitoringChange.current.pending = enabled;
    const snapshot = await audioClient
      .setMonitoring(enabled)
      .catch((error: unknown) => {
        notify(monitoringErrorText(error), 'error');
        return null;
      });
    if (id !== monitoringChange.current.id) return;
    monitoringChange.current.pending = null;
    if (snapshot) {
      setMonitoring(snapshot.monitoring);
      updatePreferences({ karaokeMonitoring: snapshot.monitoring });
    }
  }, [microphoneReady, monitoring, notify, setMonitoring, updatePreferences]);

  // Restore once per prepared session; subsequent changes belong to the monitoring switch.
  useEffect(() => {
    if (
      ready &&
      microphoneReady &&
      preferences.karaokeMonitoring &&
      !monitoring
    )
      void toggleMonitoring();
  }, [ready]);

  return { seek, changeSpeed, changeKey, changeGain, toggleMonitoring };
};
