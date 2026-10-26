import { audioClient as preview } from "../../services/audioClient";
import { useState } from "react";
import { IconButton, RotaryKnob, Typography, Waveform } from "@neo-ui-kit/react";
import type { RecordingDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { formatTime } from "../../shared/utils/format";
import { useRecordingPeaks } from "../../shared/hooks/useWaveformPeaks";
import { useRecordingPlayback } from "./useRecordingPlayback";
import { fixedKnobWidth } from "../../shared/ui/knobWidth";
import "./recording-player.css";

/** Player of one take: play/pause, seekable waveform, time and a persistent volume knob. */
export const RecordingPlayer = ({ recording }: { recording: RecordingDto }) => {
  const t = useText();
  const peaks = useRecordingPeaks(recording.id);
  const { playing, position, toggle, seek } = useRecordingPlayback(recording);
  const [volume, setVolume] = useState(1);

  const changeVolume = (value: number) => {
    setVolume(value);
    void preview.setPreviewVolume(value).catch(() => undefined);
  };

  return (
    <div className="recordingPlayer">
      <IconButton
        round
        variant="primary"
        icon={playing ? "pause" : "play"}
        label={t(playing ? "pause" : "playRecording")}
        onClick={() => void toggle()}
      />
      <div className="recordingTimeline">
        <Waveform
          points={peaks ?? undefined}
          position={position}
          duration={recording.durationSeconds}
          label={t("recordingPosition")}
          onSeek={(seconds) => void seek(seconds)}
        />
        <Typography variant="caption" tone="muted">
          {formatTime(position)} / {formatTime(recording.durationSeconds)}
        </Typography>
      </div>
      <div className="recordingVolume">
        <RotaryKnob
          diameter={58}
          style={fixedKnobWidth(58)}
          label={t("recordingVolume")}
          showLabel
          min={0}
          max={1}
          step={0.01}
          displayScale={100}
          resetValue={1}
          value={volume}
          onValueChange={changeVolume}
        />
      </div>
    </div>
  );
};
