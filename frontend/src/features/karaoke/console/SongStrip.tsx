import { Mic2 } from "lucide-react";
import type { SongDto } from "../../../contracts/models";
import { useText } from "../../../i18n/useText";
import { SeekWaveform } from "../../../shared/ui/SeekWaveform";
import { formatTime } from "../../../shared/utils/format";
import { Typography } from "../../../theme/ui";
import { useWaveformPeaks } from "./useWaveformPeaks";

interface SongStripProps {
  song: SongDto;
  position: number;
  duration: number;
  locked: boolean;
  onSeek(seconds: number): void;
}

/** Top row of the console: song identity, elapsed time, the seekable waveform and total time. */
export const SongStrip = ({ song, position, duration, locked, onSeek }: SongStripProps) => {
  const t = useText();
  const peaks = useWaveformPeaks(song.id, song.activeRevision);

  return (
    <div className="songStrip">
      <span className="songStripCover" aria-hidden>
        <Mic2 />
      </span>
      <div className="songStripTitle">
        <Typography as="strong" variant="body2" className="songStripName">
          {song.title}
        </Typography>
        <Typography variant="caption" tone="muted" className="songStripName">
          {song.artist}
        </Typography>
      </div>
      <Typography variant="caption">{formatTime(position)}</Typography>
      <SeekWaveform peaks={peaks} position={position} duration={duration} disabled={locked} label={t("songPosition")} onSeek={onSeek} />
      <Typography variant="caption">{formatTime(duration)}</Typography>
    </div>
  );
};
