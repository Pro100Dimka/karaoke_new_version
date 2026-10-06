import { Equalizer, Icon, Typography, Waveform } from "@ad-voice/ui";
import type { SongDto } from "../../../contracts/models";
import { useText } from "../../../i18n/useText";
import { formatTime } from "../../../shared/utils/format";
import { useWaveformPeaks } from "../../../shared/hooks/useWaveformPeaks";

interface SongStripProps {
  song: SongDto;
  position: number;
  duration: number;
  locked: boolean;
  playing: boolean;
  onSeek(seconds: number): void;
}

/** Top row of the console: song identity, elapsed time, the seekable waveform and total time. */
export const SongStrip = ({
  song,
  position,
  duration,
  locked,
  playing,
  onSeek,
}: SongStripProps) => {
  const t = useText();
  const peaks = useWaveformPeaks(song.id, song.activeRevision);
  return (
    <div className="songStrip">
      <span className="songStripCover" aria-hidden="true">
        {playing ? <Equalizer bars={5} playing /> : <Icon name="music" />}
      </span>
      <div className="songStripTitle">
        <Typography as="strong" variant="body-sm" weight="semibold" truncate>
          {song.title}
        </Typography>
        <Typography variant="caption" tone="muted" truncate>
          {song.artist}
        </Typography>
      </div>
      <Typography variant="caption">{formatTime(position)}</Typography>
      <Waveform
        points={peaks ?? []}
        position={position}
        duration={duration}
        disabled={locked}
        label={t("songPosition")}
        onSeek={onSeek}
      />
      <Typography variant="caption">{formatTime(duration)}</Typography>
    </div>
  );
};
