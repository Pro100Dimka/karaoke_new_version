import { pythonClient } from '../../../../services/pythonClient';
import { useGuardedAction } from '../../songs/useGuardedAction';
import {
  AnimatedBorder,
  Button,
  tr,
  IconButton,
  Loader,
  MessageBar,
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
      <RecordingTransport
        key={`${!!song}:${(song ?? recording).id}`}
        media={song ?? recording}
        original={!!song}
      />
    </AnimatedBorder>
  );
};

const RecordingVolume = ({
  volume,
  onChange,
}: {
  volume: number;
  onChange(value: number): void;
}) => {
  useLocale();
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
        onChange(volumeFromKnob(position));
      }}
    />
  );
};

const RecordingTransport = ({
  media,
  original,
}: {
  media: Pick<RecordingDto, 'id' | 'durationSeconds' | 'fileStatus'>;
  original: boolean;
}) => {
  useLocale();
  const peaks = useRecordingPeaks(media.id, original);
  const { playing, position, toggle, seek, volume, changeVolume, fileMissing } =
    useRecordingPlayback(media, original);
  if (fileMissing)
    return (
      <MessageBar
        className="recordingUnavailable"
        tone="error"
        action={
          <Button size="sm" icon="refresh" onClick={() => void toggle()}>
            {tr('retry')}
          </Button>
        }
      >
        {tr('recordingFileMissing')}
      </MessageBar>
    );
  return (
    <>
      <IconButton
        round
        aria-pressed={playing}
        variant="primary"
        icon={playing ? 'pause' : 'play'}
        label={tr(playing ? 'pause' : 'playRecording')}
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
      <div className="recordingVolume">
        <RecordingVolume volume={volume} onChange={changeVolume} />
      </div>
    </>
  );
};
