import { Button } from "../../theme/ui";
import { ArrowLeft } from "lucide-react";
import type { SongDto } from "../../contracts/models";
import type { MessageKey } from "../../i18n/messages";
import { useText } from "../../i18n/useText";
import type { KaraokeState } from "./karaokeMachine";

const stateLabels = {
  preparing: "preparing",
  ready: "ready",
  playing: "playing",
  paused: "paused",
  recovering: "recovering",
  stopping: "stopping",
  finished: "finished",
  failed: "failed"
} satisfies Record<KaraokeState["kind"], MessageKey>;

export const KaraokeHeader = ({
  song,
  state,
  speed,
  keyShift,
  onBack
}: {
  song: SongDto;
  state: KaraokeState;
  speed: number;
  keyShift: number;
  onBack(): void;
}) => {
  const t = useText();

  return (
    <header className="karaokeTop">
      <Button variant="outlined" tone="neutral" startIcon={<ArrowLeft size={18} />} onClick={onBack}>
        {t("library")}
      </Button>
      <div className="karaokeSong">
        <h1>{song.title}</h1>
        <span>
          {song.artist} · {speed.toFixed(2)}× · {keyShift > 0 ? `+${keyShift}` : keyShift} {t("semitones")}
        </span>
      </div>
      <span className={`sessionState ${state.kind}`} role="status">
        {t(stateLabels[state.kind])}
      </span>
    </header>
  );
};
