import { Button, Card, Icon, IconButton, tr, useLocale } from "@neo-ui-kit/react";
import { useNowPlaying } from "../../../app/desktop/shellBus";
import { ru } from "../../../i18n/messages.ru";
import { useKaraokeTv } from "./karaokeTv";
import "./tv.css";

/**
 * The laptop's remote while Karaoke is on the TV: what plays there and what comes next, play and
 * pause, Stop (the next song in the queue starts), and the way to bring Karaoke back.
 */
export const TvRemote = () => {
  const tv = useKaraokeTv();
  const playing = useNowPlaying();
  useLocale();
  if (!tv?.active) return null;
  const [next] = tv.queue;
  const later = tv.queue.length - 1;
  return (
    <Card border shell padding="sm" className="tvRemote" role="region" aria-label={tr(ru.tvRemote)}>
      <span className="tvRemoteIcon">
        <Icon name="window" />
      </span>
      <div className="tvRemoteSong">
        <span className="tvRemoteLabel">{tr(ru.tvNowPlaying)}</span>
        <strong className="tvRemoteTitle">
          {playing ? [playing.title, playing.artist].filter(Boolean).join(" — ") : tr(ru.loadingSong)}
        </strong>
        {next && (
          <span className="tvRemoteNext">
            {later > 0
              ? tr(ru.tvNextMany, { title: next.title, count: later })
              : tr(ru.tvNext, { title: next.title })}
          </span>
        )}
      </div>
      <IconButton
        round
        icon={playing?.playing ? "pause" : "play"}
        label={tr(ru[playing?.playing ? "pause" : "tvPlay"])}
        disabled={!playing}
        onClick={() => playing?.togglePlayback()}
      />
      <IconButton round icon="stop" label={tr(ru.tvStop)} onClick={tv.stop} />
      <Button size="sm" icon="back" onClick={tv.bringBack}>
        {tr(ru.tvBringBack)}
      </Button>
    </Card>
  );
};
