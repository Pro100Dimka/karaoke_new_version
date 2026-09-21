import { useEffect, useRef, useState } from "react";
import type { SongDto } from "../../contracts/models";
import { Typography } from "../../theme/ui";
import "./karaoke-intro.css";

const holdMilliseconds = 2400;
const fadeOutMilliseconds = 800;

interface KaraokeIntroProps {
  /** The song is known once its project has loaded; the hold timer starts then. */
  song: SongDto | null;
  onStart(): void;
  onDone(): void;
}

/**
 * Scene opening: the screen is dark from the first frame (the library fades to black just before), the song is announced,
 * then the screen brightens; playback starts as the fade-out begins.
 */
export const KaraokeIntro = ({ song, onStart, onDone }: KaraokeIntroProps) => {
  const [leaving, setLeaving] = useState(false);
  const ready = song !== null;
  // The timers must not restart when the parent re-renders with new callback identities.
  const callbacks = useRef({ onStart, onDone });
  callbacks.current = { onStart, onDone };

  useEffect(() => {
    if (!ready) return;
    const hold = window.setTimeout(() => {
      setLeaving(true);
      callbacks.current.onStart();
    }, holdMilliseconds);
    return () => window.clearTimeout(hold);
  }, [ready]);

  useEffect(() => {
    if (!leaving) return;
    const fade = window.setTimeout(() => callbacks.current.onDone(), fadeOutMilliseconds);
    return () => window.clearTimeout(fade);
  }, [leaving]);

  return (
    <div className="karaokeIntro" data-leaving={leaving || undefined} aria-live="polite">
      {song && (
        <div className="karaokeIntroInfo">
          <Typography variant="h2" align="center">
            {song.title}
          </Typography>
          <Typography variant="h5" tone="muted" align="center">
            {song.artist}
          </Typography>
        </div>
      )}
    </div>
  );
};
