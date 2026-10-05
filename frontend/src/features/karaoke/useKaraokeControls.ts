import { canControlRoom } from "../room/roomModel";
import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { useApp } from "../../app/AppContext";
import type { MixerChannelGains } from "../../contracts/models";
import { audioClient } from "../../services/audioClient";
import { recordingCoordinator } from "../../services/recordingCoordinator";
import { roomClient } from "../../services/roomClient";
import { sharedStateOf } from "../../services/roomMappers";
import type { Preferences } from "../../shared/preferences/preferences";

/** Stored preference for every mixer channel, so a change is kept for the next session. */
const gainPreferences = {
  music: "musicGain",
  mic: "voiceGain",
  reference: "referenceGain",
  melody: "melodyGain",
  master: "masterGain",
} as const satisfies Record<keyof MixerChannelGains, keyof Preferences>;
interface KaraokeControlsOptions {
  position: MutableRefObject<number>;
  speed: MutableRefObject<number>;
  key: MutableRefObject<number>;
  monitoring: boolean;
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
  microphoneReady,
  setPosition,
  setSpeed,
  setKeyShift,
  setGains,
  setMonitoring
}: KaraokeControlsOptions) => {
  const { updatePreferences, room, setRoom } = useApp();

  const publishPracticeParameters = useCallback(async (playbackRate: number, keyShift: number) => {
    if (!room || !canControlRoom(room) || room.playbackLocked) return false;
    const updated = await roomClient.updateSharedState(room.code, { ...sharedStateOf(room), playbackRate, keyShift })
      .catch(() => null);
    if (!updated) return false;
    setRoom(updated);
    return true;
  }, [room, setRoom]);

  const seek = useCallback(
    async (seconds: number) => {
      if (room) {
        if (!canControlRoom(room)) return;
        const updated = await roomClient.roomControl(room.code, "Seek", seconds).catch(() => null);
        if (updated) setRoom(updated);
        return;
      }
      const snapshot = await audioClient.seek(seconds).catch(() => null);
      if (!snapshot) return;
      position.current = snapshot.positionSeconds;
      setPosition(snapshot.positionSeconds);
    },
    [position, room, setPosition, setRoom]
  );

  const changeSpeed = useCallback(
    async (value: number) => {
      if (room && !(await publishPracticeParameters(value, key.current))) return;
      speed.current = value;
      setSpeed(value);
      await audioClient.setPlaybackRate(value).catch(() => undefined);
      recordingCoordinator.updatePlaybackAdjustment({
        sourceSeconds: position.current,
        playbackRate: value,
        keyShift: key.current
      });
    },
    [key, position, publishPracticeParameters, room, setSpeed, speed]
  );

  const changeKey = useCallback(
    async (delta: number) => {
      const next = Math.max(-12, Math.min(12, key.current + delta));
      if (room && !(await publishPracticeParameters(speed.current, next))) return;
      key.current = next;
      setKeyShift(next);
      await audioClient.setPitchShift(next).catch(() => undefined);
      recordingCoordinator.updatePlaybackAdjustment({
        sourceSeconds: position.current,
        playbackRate: speed.current,
        keyShift: next
      });
    },
    [key, position, publishPracticeParameters, room, setKeyShift, speed]
  );

  const changeGain = useCallback(
    async (channel: keyof MixerChannelGains, value: number) => {
      setGains(current => ({ ...current, [channel]: value }));
      updatePreferences({ [gainPreferences[channel]]: value });
      // The microphone is applied by the voice chain from the stored value (a room holds it at full).
      if (channel === "mic") return;
      await audioClient.setMixer(channel, value).catch(() => undefined);
    },
    [setGains, updatePreferences]
  );

  const toggleMonitoring = useCallback(async () => {
    if (!microphoneReady) return;
    const snapshot = await audioClient.setMonitoring(!monitoring).catch(() => null);
    if (snapshot) setMonitoring(snapshot.monitoring);
  }, [microphoneReady, monitoring, setMonitoring]);

  return { seek, changeSpeed, changeKey, changeGain, toggleMonitoring };
};
