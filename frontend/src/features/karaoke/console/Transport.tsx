import { IconButton } from "@ad-voice/ui";
import type { MessageKey } from "../../../i18n/messages";
import { useText } from "../../../i18n/useText";
import type { KaraokeState } from "../karaokeMachine";

const skipSeconds = 10;

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
export const Transport = ({
  state,
  position,
  duration,
  seekLocked,
  onSeek,
  onTogglePlay,
  onStop,
}: TransportProps) => {
  const t = useText();
  const playing = state.kind === "playing";
  const usable =
    state.kind === "ready" ||
    state.kind === "playing" ||
    state.kind === "paused";
  const disabled = seekLocked || !usable;
  const actions = [
    {
      id: "restart",
      label: "restart",
      icon: "back",
      primary: false,
      run: () => onSeek(0),
    },
    {
      id: "play",
      label: playing ? "pause" : "play",
      icon: playing ? "pause" : "play",
      primary: true,
      run: onTogglePlay,
    },
    { id: "stop", label: "stop", icon: "stop", primary: false, run: onStop },
    {
      id: "forward",
      label: "skipForward",
      icon: "prev",
      primary: false,
      run: () => onSeek(Math.min(duration, position + skipSeconds)),
    },
  ] satisfies readonly {
    id: string;
    label: MessageKey;
    icon: string;
    primary: boolean;
    run(): void;
  }[];

  return (
    <div
      className="transport"
      role="toolbar"
      aria-label={t("transportControls")}
    >
      {actions.map((action) => (
        <IconButton
          key={action.id}
          round
          className={action.id === "forward" ? "transportForward" : undefined}
          size={action.primary ? "lg" : "md"}
          variant={action.primary ? "primary" : "secondary"}
          icon={action.icon}
          label={t(action.label)}
          disabled={disabled}
          onClick={action.run}
        />
      ))}
    </div>
  );
};
