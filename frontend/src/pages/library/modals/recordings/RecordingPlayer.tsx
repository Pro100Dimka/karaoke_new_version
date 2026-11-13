import { observeOperation } from '../../../../shared/errors';
import { pythonClient } from '../../../../services/pythonClient';
import { useGuardedAction } from '../../songs/useGuardedAction';
import { audioClient as preview } from '../../../../services/audioClient';
import { useState } from 'react';
import {
  Button,
  tr,
  IconButton,
  Loader,
  RotaryKnob,
  Typography,
  Waveform,
  useLocale,
} from '@neo-ui-kit/react';
import type { RecordingDto } from '../../../../contracts/models';
import { formatTime } from '../../../../shared/utils/format';
import { useRecordingPeaks } from '../../../../shared/hooks/useWaveformPeaks';
import { useRecordingPlayback } from './useRecordingPlayback';
import { fixedKnobWidth } from '../../../../shared/ui/knobWidth';
import './recording-player.css';

/** Player of one take: play/pause, seekable waveform, time and a persistent volume knob. */
export const RecordingPlayer = ({ recording }: { recording: RecordingDto }) => {
  useLocale();
  const guarded = useGuardedAction();
  if (['Preparing', 'PreparationFailed'].includes(recording.fileStatus ?? ''))
    return (
      <div role="status">
        {recording.fileStatus === 'Preparing' && (
          <Loader animation="wave" size="sm" label={tr('recordingPreparing')} />
        )}
        <Typography>
          {tr(
            recording.fileStatus === 'Preparing'
              ? 'Подготовка записи в фоне. Исходные дорожки сохранены.'
              : 'Не удалось подготовить запись. Исходные дорожки сохранены.',
          )}
        </Typography>
        {recording.fileStatus === 'PreparationFailed' && (
          <Button
            onClick={() =>
              void guarded(async () => {
                await pythonClient.retryRecordingPreparation(recording.id);
              })
            }
            label={tr('Повторить подготовку')}
          />
        )}
      </div>
    );
  return <ReadyRecordingPlayer recording={recording} />;
};

const ReadyRecordingPlayer = ({ recording }: { recording: RecordingDto }) => (
  <div className="recordingPlayer">
    <RecordingTransport recording={recording} />
    <div className="recordingVolume">
      <RecordingVolume />
    </div>
  </div>
);

const RecordingVolume = () => {
  useLocale();
  const [volume, setVolume] = useState(1);
  return (
    <RotaryKnob
      diameter={58}
      style={fixedKnobWidth(58)}
      label={tr('recordingVolume')}
      showLabel
      min={0}
      max={1}
      step={0.01}
      displayScale={100}
      resetValue={1}
      value={volume}
      onValueChange={(value) => {
        void observeOperation(
          'errors.previewVolume',
          preview.setPreviewVolume(value),
        ).then(
          () => setVolume(value),
          () => undefined,
        );
      }}
    />
  );
};

const RecordingTransport = ({ recording }: { recording: RecordingDto }) => {
  useLocale();
  const peaks = useRecordingPeaks(recording.id);
  const { playing, position, toggle, seek } = useRecordingPlayback(recording);
  return (
    <>
      <IconButton
        round
        variant="primary"
        icon={playing ? 'pause' : 'play'}
        label={tr(playing ? 'pause' : 'playRecording')}
        onClick={() => void toggle()}
      />
      <div className="recordingTimeline">
        <Waveform
          points={peaks ?? undefined}
          position={position}
          duration={recording.durationSeconds}
          label={tr('recordingPosition')}
          onSeek={(seconds) => void seek(seconds)}
        />
        <Typography variant="caption" tone="muted">
          {formatTime(position)} / {formatTime(recording.durationSeconds)}
        </Typography>
      </div>
    </>
  );
};
