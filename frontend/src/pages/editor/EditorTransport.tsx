import { IconButton, Typography, Waveform, tr, useLocale } from "@neo-ui-kit/react";
import { ru } from "../../i18n/messages.ru";
import { useWaveformPeaks } from "../../shared/hooks/useWaveformPeaks";
import { formatPreciseTime } from "../../shared/utils/format";

const emptyPeaks: readonly number[] = [];

interface EditorTransportProps {
  songId: string;
  revision: number;
  playing: boolean;
  position: number;
  duration: number;
  audioReady: boolean;
  onTogglePlay(): void;
  onSeek(seconds: number): void;
}

/** Listening to the melody: play or pause and the song's real waveform to seek through it. */
export const EditorTransport = ({
  songId,
  revision,
  playing,
  position,
  duration,
  audioReady,
  onTogglePlay,
  onSeek,
}: EditorTransportProps) => {
  useLocale();
  const peaks = useWaveformPeaks(songId, revision);
  return (
    <section className="editorTransport" aria-label={tr(ru.editorTransport)}>
      <IconButton
        round
        size="lg"
        variant="primary"
        icon={playing ? "pause" : "play"}
        disabled={!audioReady}
        label={tr(ru[playing ? "pause" : "editorListen"])}
        onClick={onTogglePlay}
      />
      <Typography variant="mono">{formatPreciseTime(position)}</Typography>
      <Waveform
        points={peaks ?? emptyPeaks}
        position={position}
        duration={Math.max(duration, 1)}
        label={tr(ru.songPosition)}
        onSeek={onSeek}
      />
      <Typography variant="mono" tone="muted">
        {formatPreciseTime(duration)}
      </Typography>
    </section>
  );
};
