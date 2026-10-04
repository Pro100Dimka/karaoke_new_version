import { useRef, useState } from "react";
import { IconButton, Slider, Typography, Waveform } from "@ad-voice/ui";
import type { RecordingDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { audioClient } from "../../services/audioClient";
import { formatTime } from "../../shared/utils/format";
import { useRecordingPeaks } from "./useRecordingPeaks";
import { useRecordingPlayback } from "./useRecordingPlayback";
import "./recording-player.css";

/** Player of one take: play/pause, seekable waveform with the elapsed and total time, and a volume control that opens on hover. */
export const RecordingPlayer = ({ recording }: { recording: RecordingDto }) => {
  const t = useText();
  const peaks = useRecordingPeaks(recording.id);
  const { playing, position, toggle, seek } = useRecordingPlayback(recording);
  const [volume, setVolume] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const remembered = useRef(1);

  const changeVolume = (value: number) => {
    if (value > 0) remembered.current = value;
    setVolume(value);
    void audioClient.setPreviewVolume(value).catch(() => undefined);
  };

  return (
    <div className="recordingPlayer">
      <IconButton round variant="primary" icon={playing ? "pause" : "play"} label={t(playing ? "pause" : "playRecording")}
        onClick={() => void toggle()} />
      <div className="recordingTimeline">
        <Waveform points={peaks ?? undefined} position={position} duration={recording.durationSeconds}
          label={t("recordingPosition")} onSeek={seconds => void seek(seconds)} />
        <Typography variant="caption" tone="muted">
          {formatTime(position)} / {formatTime(recording.durationSeconds)}
        </Typography>
      </div>
      <div className="recordingVolume" data-expanded={expanded || undefined}
        onPointerEnter={() => setExpanded(true)}
        onPointerLeave={() => setExpanded(false)}
        onFocusCapture={() => setExpanded(true)}
        onBlurCapture={event => {
          if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(false);
        }}>
        <IconButton variant="ghost" icon="volume" label={t(volume > 0 ? "mute" : "unmute")} aria-pressed={volume === 0}
          onClick={() => changeVolume(volume > 0 ? 0 : remembered.current)} />
        <Slider className="recordingVolumeSlider" label={t("recordingVolume")} min={0} max={1} step={0.05} value={volume}
          onValueChange={changeVolume} />
      </div>
    </div>
  );
};
