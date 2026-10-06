import { IconButton, Typography, Waveform } from "@ad-voice/ui";
import { useText } from "../../i18n/useText";
import { useWaveformPeaks } from "../../shared/hooks/useWaveformPeaks";
import { formatPreciseTime } from "../../shared/utils/format";

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
  const t = useText();
  const peaks = useWaveformPeaks(songId, revision);
  return (
    <section className="editorTransport" aria-label={t("editorTransport")}>
      <IconButton
        round
        size="lg"
        variant="primary"
        icon={playing ? "pause" : "play"}
        disabled={!audioReady}
        label={t(playing ? "pause" : "editorListen")}
        onClick={onTogglePlay}
      />
      <Typography variant="mono">{formatPreciseTime(position)}</Typography>
      <Waveform
        points={peaks ?? []}
        position={position}
        duration={Math.max(duration, 1)}
        label={t("songPosition")}
        onSeek={onSeek}
      />
      <Typography variant="mono" tone="muted">
        {formatPreciseTime(duration)}
      </Typography>
    </section>
  );
};
