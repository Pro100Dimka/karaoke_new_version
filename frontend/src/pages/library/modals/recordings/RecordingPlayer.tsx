import { observeOperation } from '../../../../shared/errors';
import { pythonClient } from '../../../../services/pythonClient';
import { useGuardedAction } from '../../songs/useGuardedAction';
import { audioClient as preview } from '../../../../services/audioClient';
import { observer } from 'mobx-react-lite';
import { runInAction } from 'mobx';
import { store } from '../../../../providers/store';
import {
  AnimatedBorder,
  Button,
  tr,
  IconButton,
  Loader,
  RotaryKnob,
  Typography,
  Waveform,
  useLocale,
} from '@neo-ui-kit/react';
import type { RecordingDto, SongDto } from '../../../../contracts/models';
import { formatTime } from '../../../../shared/utils/format';
import { useRecordingPeaks } from '../../../../shared/hooks/useWaveformPeaks';
import { useRecordingPlayback } from './useRecordingPlayback';
import { fixedKnobWidth } from '../../../../shared/ui/knobWidth';
import {
  volumeFromKnob,
  volumeToKnob,
} from '../../../../shared/utils/mixerLevel';
import './recording-player.css';

/** Player of one take: play/pause, seekable waveform, time and a persistent volume knob. */
export const RecordingPlayer = ({
  recording,
  song,
}:
  | { recording: RecordingDto; song?: never }
  | { song: SongDto; recording?: never }) => {
  useLocale();
  const guarded = useGuardedAction();
  if (
    recording &&
    ['Preparing', 'PreparationFailed'].includes(recording.fileStatus ?? '')
  )
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
  return (
    <AnimatedBorder className="recordingPlayer">
      <RecordingTransport media={song ?? recording} original={!!song} />
      <div className="recordingVolume">
        <RecordingVolume />
      </div>
    </AnimatedBorder>
  );
};

const RecordingVolume = observer(() => {
  useLocale();
  const volume = store.playback.previewVolume;
  return (
    <RotaryKnob
      diameter={58}
      style={fixedKnobWidth(58)}
      label={tr('recordingVolume')}
      min={0}
      max={1}
      step={0.01}
      displayScale={100}
      resetValue={1}
      value={volumeToKnob(volume)}
      onValueChange={(position) => {
        const value = volumeFromKnob(position);
        void observeOperation(
          'errors.previewVolume',
          preview.setPreviewVolume(value),
        ).then(
          () => runInAction(() => { store.playback.previewVolume = value; }),
          () => undefined,
        );
      }}
    />
  );
});

const RecordingTransport = ({
  media,
  original,
}: {
  media: Pick<RecordingDto, 'id' | 'durationSeconds'>;
  original: boolean;
}) => {
  useLocale();
  const peaks = useRecordingPeaks(media.id, original);
  const { playing, position, toggle, seek } = useRecordingPlayback(
    media,
    original,
  );
  return (
    <>
      <IconButton
        round
        aria-pressed={playing}
        variant="primary"
        icon={playing ? 'pause' : 'play'}
        label={tr(playing ? 'pause' : original ? 'play' : 'playRecording')}
        onClick={() => void toggle()}
      />
      <div className="recordingTimeline">
        <Waveform
          points={peaks ?? undefined}
          position={position}
          duration={media.durationSeconds}
          label={tr('recordingPosition')}
          onSeek={(seconds) => void seek(seconds)}
        />
        <Typography variant="caption" tone="muted" className="recordingTimes">
          <span>{formatTime(position)}</span>
          <span>{formatTime(media.durationSeconds)}</span>
        </Typography>
      </div>
    </>
  );
};
