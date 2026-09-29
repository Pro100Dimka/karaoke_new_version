import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { useApp } from "../../app/AppContext";
import type { MixerChannelGains } from "../../contracts/models";
import { audioClient } from "../../services/audioClient";
import { recordingCoordinator } from "../../services/recordingCoordinator";
import { roomClient } from "../../services/roomClient";
import type { Preferences } from "../../shared/preferences/preferences";

/** Stored preference for every mixer channel, so a change is kept for the next session. */
const gainPreferences = {
  music: "musicGain",
  mic: "voiceGain",
  reference: "referenceGain",
  melody: "melodyGain",
  master: "masterGain",
} as const satisfies Record<keyof MixerChannelGains, keyof Preferences>;
const roomGainPreferences = {
  music: "musicGain",
  reference: "referenceGain",
  melody: "melodyGain",
} as const;

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
  const sharedGains = useRef({ musicGain: 0.82, referenceGain: 0, melodyGain: 0 });
  const gainPublication = useRef(Promise.resolve());
  useEffect(() => {
    if (!room) return;
    sharedGains.current = {
      musicGain: room.musicGain ?? 0.82,
      referenceGain: room.referenceGain ?? 0,
      melodyGain: room.melodyGain ?? 0,
    };
  }, [room?.code, room?.musicGain, room?.referenceGain, room?.melodyGain]);

  const publishPracticeParameters = useCallback(async (playbackRate: number, keyShift: number) => {
    if (!room || (room.role !== "host" && !room.collaborativeControl) || room.playbackLocked) return false;
    const updated = await roomClient.updateSharedState(room.code, {
      radioEnabled: room.radioEnabled ?? false,
      radioStationId: room.radioStationId ?? "groove-salad",
      libraryQuery: room.libraryQuery ?? "",
      libraryStatus: room.libraryStatus ?? "all",
      librarySort: room.librarySort ?? "recent",
      playbackRate,
      keyShift,
      musicGain: room.musicGain ?? 0.82,
      referenceGain: room.referenceGain ?? 0,
      melodyGain: room.melodyGain ?? 0,
    }).catch(() => null);
    if (!updated) return false;
    setRoom(updated);
    return true;
  }, [room, setRoom]);

  const seek = useCallback(
    async (seconds: number) => {
      if (room) {
        if (room.role !== "host" && !room.collaborativeControl) return;
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
      const sharedChannel = ["music", "reference", "melody"].includes(channel);
      if (room && sharedChannel && room.role !== "host" && !room.collaborativeControl) return;
      if (room && sharedChannel) {
        const gainKey = roomGainPreferences[channel as keyof typeof roomGainPreferences];
        sharedGains.current = { ...sharedGains.current, [gainKey]: value };
      }
      setGains(current => ({ ...current, [channel]: value }));
      updatePreferences({ [gainPreferences[channel]]: value });
      await audioClient.setMixer(channel, value).catch(() => undefined);
      if (room && sharedChannel) {
        const publish = async () => {
          const updated = await roomClient.updateSharedState(room.code, {
            radioEnabled: room.radioEnabled ?? false,
            radioStationId: room.radioStationId ?? "groove-salad",
            libraryQuery: room.libraryQuery ?? "",
            libraryStatus: room.libraryStatus ?? "all",
            librarySort: room.librarySort ?? "recent",
            playbackRate: room.playbackRate ?? 1,
            keyShift: room.keyShift ?? 0,
            ...sharedGains.current,
          }).catch(() => null);
          if (updated) setRoom(updated);
        };
        gainPublication.current = gainPublication.current.then(publish, publish);
        await gainPublication.current;
      }
    },
    [room, setGains, setRoom, updatePreferences]
  );

  const toggleMonitoring = useCallback(async () => {
    if (!microphoneReady) return;
    const snapshot = await audioClient.setMonitoring(!monitoring).catch(() => null);
    if (snapshot) setMonitoring(snapshot.monitoring);
  }, [microphoneReady, monitoring, setMonitoring]);

  return { seek, changeSpeed, changeKey, changeGain, toggleMonitoring };
};
