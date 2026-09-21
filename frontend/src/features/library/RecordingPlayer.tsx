import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { useRef, useState } from "react";
import type { RecordingDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { audioClient } from "../../services/audioClient";
import { SeekWaveform } from "../../shared/ui/SeekWaveform";
import { formatTime } from "../../shared/utils/format";
import { IconButton, Slider, Typography } from "../../theme/ui";
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
      <IconButton icon={playing ? Pause : Play} label={t(playing ? "pause" : "playRecording")} variant="outline" onClick={() => void toggle()} />
      <div className="recordingTimeline">
        <SeekWaveform peaks={peaks} position={position} duration={recording.durationSeconds} disabled={false} label={t("recordingPosition")} onSeek={seconds => void seek(seconds)} />
        <Typography variant="caption" tone="muted" className="recordingTime">
          {formatTime(position)} / {formatTime(recording.durationSeconds)}
        </Typography>
      </div>
      <div
        className="recordingVolume"
        onPointerEnter={() => setExpanded(true)}
        onPointerLeave={() => setExpanded(false)}
        onFocusCapture={() => setExpanded(true)}
        onBlurCapture={event => {
          if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(false);
        }}
      >
        <IconButton icon={volume > 0 ? Volume2 : VolumeX} label={t(volume > 0 ? "mute" : "unmute")} variant="ghost" onClick={() => changeVolume(volume > 0 ? 0 : remembered.current)} />
        <div className="recordingVolumeSlider" data-expanded={expanded || undefined}>
          <Slider aria-label={t("recordingVolume")} min={0} max={1} step={0.05} value={volume} showValue={false} onChange={changeVolume} />
        </div>
      </div>
    </div>
  );
};
