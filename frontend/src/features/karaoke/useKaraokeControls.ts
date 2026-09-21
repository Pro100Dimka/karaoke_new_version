import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { useApp } from "../../app/AppContext";
import type { MixerChannelGains } from "../../contracts/models";
import { audioClient } from "../../services/audioClient";
import type { RecordingUiState } from "./useKaraokeSession";

interface KaraokeControlsOptions {
  recording: MutableRefObject<RecordingUiState>;
  position: MutableRefObject<number>;
  key: MutableRefObject<number>;
  monitoring: boolean;
  microphoneReady: boolean;
  setPosition: Dispatch<SetStateAction<number>>;
  setSpeed: Dispatch<SetStateAction<number>>;
  setKeyShift: Dispatch<SetStateAction<number>>;
  setGains: Dispatch<SetStateAction<MixerChannelGains>>;
  setMonitoring: Dispatch<SetStateAction<boolean>>;
}

/** Transport-adjacent controls; seek, speed and key are locked while a take is being recorded. */
export const useKaraokeControls = ({
  recording,
  position,
  key,
  monitoring,
  microphoneReady,
  setPosition,
  setSpeed,
  setKeyShift,
  setGains,
  setMonitoring
}: KaraokeControlsOptions) => {
  const { updatePreferences } = useApp();

  const seek = useCallback(
    async (seconds: number) => {
      if (recording.current === "recording") return;
      const snapshot = await audioClient.seek(seconds).catch(() => null);
      if (!snapshot) return;
      position.current = snapshot.positionSeconds;
      setPosition(snapshot.positionSeconds);
    },
    [recording, position, setPosition]
  );

  const changeSpeed = useCallback(
    async (value: number) => {
      if (recording.current === "recording") return;
      setSpeed(value);
      await audioClient.setPlaybackRate(value).catch(() => undefined);
    },
    [recording, setSpeed]
  );

  const changeKey = useCallback(
    async (delta: number) => {
      if (recording.current === "recording") return;
      const next = Math.max(-12, Math.min(12, key.current + delta));
      setKeyShift(next);
      await audioClient.setPitchShift(next).catch(() => undefined);
    },
    [recording, key, setKeyShift]
  );

  const changeGain = useCallback(
    async (channel: keyof MixerChannelGains, value: number) => {
      setGains(current => ({ ...current, [channel]: value }));
      if (channel === "music") updatePreferences({ musicGain: value });
      if (channel === "mic") updatePreferences({ voiceGain: value });
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
