import { Pause, Play, SkipBack, SkipForward, Square, type LucideIcon } from "lucide-react";
import type { MessageKey } from "../../../i18n/messages";
import { useText } from "../../../i18n/useText";
import { IconButton } from "../../../theme/ui";
import type { KaraokeState } from "../karaokeMachine";

const skipSeconds = 10;
const playButtonSize = 60;

interface TransportProps {
  state: KaraokeState;
  position: number;
  duration: number;
  seekLocked: boolean;
  onSeek(seconds: number): void;
  onTogglePlay(): void;
  onStop(): void;
}

/** Restart, play/pause, stop and skip-forward buttons of the console's top row. */
export const Transport = ({ state, position, duration, seekLocked, onSeek, onTogglePlay, onStop }: TransportProps) => {
  const t = useText();
  const playing = state.kind === "playing";
  const usable = state.kind === "ready" || state.kind === "playing" || state.kind === "paused";
  const actions = [
    { id: "restart", label: "restart", icon: SkipBack, primary: false, disabled: seekLocked || !usable, run: () => onSeek(0) },
    { id: "play", label: playing ? "pause" : "play", icon: playing ? Pause : Play, primary: true, disabled: seekLocked || !usable, run: onTogglePlay },
    { id: "stop", label: "stop", icon: Square, primary: false, disabled: seekLocked || !usable, run: onStop },
    { id: "forward", label: "skipForward", icon: SkipForward, primary: false, disabled: seekLocked || !usable, run: () => onSeek(Math.min(duration, position + skipSeconds)) }
  ] satisfies readonly { id: string; label: MessageKey; icon: LucideIcon; primary: boolean; disabled: boolean; run(): void }[];

  return (
    <div className="transport" role="toolbar" aria-label={t("transportControls")}>
      {actions.map(action => (
        <IconButton
          key={action.id}
          icon={action.icon}
          label={t(action.label)}
          variant={action.primary ? "contained" : "outline"}
          iconSize={action.primary ? playButtonSize : undefined}
          disabled={action.disabled}
          onClick={action.run}
        />
      ))}
    </div>
  );
};
