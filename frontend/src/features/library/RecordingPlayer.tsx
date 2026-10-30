import { pythonClient } from "../../services/pythonClient";
import { useGuardedAction } from "./useGuardedAction";
import { audioClient as preview } from "../../services/audioClient";
import { useMemo, useState } from "react";
import { Button, tr, IconButton, RotaryKnob, Typography, Waveform } from "@neo-ui-kit/react";
import type { RecordingDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { formatTime } from "../../shared/utils/format";
import { useRecordingPeaks } from "../../shared/hooks/useWaveformPeaks";
import { useRecordingPlayback } from "./useRecordingPlayback";
import { fixedKnobWidth } from "../../shared/ui/knobWidth";
import "./recording-player.css";

/** Player of one take: play/pause, seekable waveform, time and a persistent volume knob. */
export const RecordingPlayer = ({ recording }: { recording: RecordingDto }) => {
  const guarded = useGuardedAction();
  if (["Preparing", "PreparationFailed"].includes(recording.fileStatus ?? ""))
    return <div role="status">
      <Typography>{tr(recording.fileStatus === "Preparing" ? "Подготовка записи в фоне. Исходные дорожки сохранены." : "Не удалось подготовить запись. Исходные дорожки сохранены.")}</Typography>
      {recording.fileStatus === "PreparationFailed" && <Button onClick={() => void guarded(async () => { await pythonClient.retryRecordingPreparation(recording.id); })}>{tr("Повторить подготовку")}</Button>}
    </div>;
  return <ReadyRecordingPlayer recording={recording} />;
};

const ReadyRecordingPlayer = ({ recording }: { recording: RecordingDto }) => {
  const t = useText();
  const peaks = useRecordingPeaks(recording.id);
  const { playing, position, toggle, seek } = useRecordingPlayback(recording);
  const [volume, setVolume] = useState(1);

  const volumeControl = useMemo(() => (
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
      onValueChange={(value) => {
        setVolume(value);
        void preview.setPreviewVolume(value).catch(() => undefined);
      }}
    />
  ), [t, volume]);

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
        {volumeControl}
      </div>
    </div>
  );
};
