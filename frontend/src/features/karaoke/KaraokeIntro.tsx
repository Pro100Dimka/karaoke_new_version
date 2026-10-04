import { useEffect, useRef, useState } from "react";
import type { SongDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { Badge, Card, Icon, Typography } from "@ad-voice/ui";
import "./karaoke-intro.css";

const holdMilliseconds = 2400;
const fadeOutMilliseconds = 800;

interface KaraokeIntroProps {
  /** The song is known once its project has loaded; the hold timer starts then. */
  song: SongDto | null;
  /** Metadata may arrive before stems and the audio device are ready; keep the intro as the loader. */
  ready?: boolean;
  onStart(): void;
  onDone(): void;
}

/**
 * Scene opening: the screen is dark from the first frame (the library fades to black just before), the song is announced,
 * then the screen brightens; playback starts as the fade-out begins.
 */
export const KaraokeIntro = ({ song, ready = true, onStart, onDone }: KaraokeIntroProps) => {
  const t = useText();
  const [leaving, setLeaving] = useState(false);
  const canLeave = song !== null && ready;
  // The timers must not restart when the parent re-renders with new callback identities.
  const callbacks = useRef({ onStart, onDone });
  callbacks.current = { onStart, onDone };

  useEffect(() => {
    if (!canLeave) return;
    const hold = window.setTimeout(() => {
      setLeaving(true);
      callbacks.current.onStart();
    }, holdMilliseconds);
    return () => window.clearTimeout(hold);
  }, [canLeave]);

  useEffect(() => {
    if (!leaving) return;
    const fade = window.setTimeout(() => callbacks.current.onDone(), fadeOutMilliseconds);
    return () => window.clearTimeout(fade);
  }, [leaving]);

  return (
    <div className="karaokeIntro" data-leaving={leaving || undefined} aria-live="polite">
      {song && (
        <Card border shell padding="none" className="karaokeIntroCard">
          <div className="karaokeIntroCover">
            {song.artworkUrl ? <img src={song.artworkUrl} alt={song.title} /> : <Icon name="music" />}
          </div>
          <div className="karaokeIntroText">
            <Typography variant="eyebrow" tone="accent">{t("nowItWillSound")}</Typography>
            <Typography variant="display" align="center">{song.title}</Typography>
            <Typography variant="h3" tone="muted" align="center">{song.artist}</Typography>
            {(song.album || song.genre) && (
              <div className="karaokeIntroTags">
                {song.album && <Badge>{song.album}</Badge>}
                {song.genre && <Badge>{song.genre}</Badge>}
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
};
