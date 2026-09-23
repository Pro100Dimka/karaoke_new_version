import { ChevronLeft, ChevronRight, Minus, Pause, Play, Plus, SkipBack, SkipForward, Square, type LucideIcon } from "lucide-react";
import type { MessageKey } from "../../../i18n/messages";
import { useText } from "../../../i18n/useText";
import { Card, IconButton, Typography } from "../../../theme/ui";
import type { KaraokeState } from "../karaokeMachine";
import { rangeLabel, type NoteRange } from "./noteRange";

const skipSeconds = 10;
const maxKeyShift = 12;
const minPlaybackRate = 0.5;
const maxPlaybackRate = 1.5;
const tempoStepBpm = 1;
const playButtonSize = 60;

interface StepAction {
  icon: LucideIcon;
  label: MessageKey;
  disabled: boolean;
  run(): void;
}

interface Metric {
  id: string;
  label: MessageKey;
  value: string;
  tone: string;
  previous?: StepAction;
  next?: StepAction;
}

const MetricCard = ({ metric }: { metric: Metric }) => {
  const t = useText();
  const step = (action: StepAction | undefined) =>
    action && <IconButton icon={action.icon} label={t(action.label)} size="sm" variant="outline" disabled={action.disabled} onClick={action.run} />;

  return (
    <Card tilt={false} className="metricCard" sx={{ "--card-border": metric.tone }}>
      <div className="metricBody">
        <Typography variant="caption" style={{ color: metric.tone }}>
          {t(metric.label)}
        </Typography>
        <div className="metricValue">
          {step(metric.previous)}
          <Typography variant="body2">
            <strong>{metric.value}</strong>
          </Typography>
          {step(metric.next)}
        </div>
      </div>
    </Card>
  );
};

interface ConsoleCenterProps {
  state: KaraokeState;
  position: number;
  duration: number;
  speed: number;
  baseBpm?: number;
  keyShift: number;
  range: NoteRange | null;
  locked: boolean;
  seekLocked: boolean;
  onSeek(seconds: number): void;
  onTogglePlay(): void;
  onStop(): void;
  onSpeedChange(value: number): void;
  onKeyChange(delta: number): void;
}

/** Transport buttons plus the three practice read-outs: speed, key and the vocal range of the song. */
export const ConsoleCenter = ({ state, position, duration, speed, baseBpm, keyShift, range, locked, seekLocked, onSeek, onTogglePlay, onStop, onSpeedChange, onKeyChange }: ConsoleCenterProps) => {
  const t = useText();
  const playing = state.kind === "playing";
  const usable = state.kind === "ready" || state.kind === "playing" || state.kind === "paused";
  const validBaseBpm = typeof baseBpm === "number" && Number.isFinite(baseBpm) && baseBpm > 0 ? baseBpm : null;
  const tempoBpm = validBaseBpm === null ? null : Math.round(validBaseBpm * speed);
  const changeTempo = (delta: number) => {
    if (validBaseBpm === null || tempoBpm === null) return;
    const nextBpm = tempoBpm + delta;
    onSpeedChange(Math.max(minPlaybackRate, Math.min(maxPlaybackRate, nextBpm / validBaseBpm)));
  };
  const transport = [
    { id: "restart", label: "restart", icon: SkipBack, primary: false, disabled: seekLocked || !usable, run: () => onSeek(0) },
    { id: "play", label: playing ? "pause" : "play", icon: playing ? Pause : Play, primary: true, disabled: !usable, run: onTogglePlay },
    { id: "stop", label: "stop", icon: Square, primary: false, disabled: !usable, run: onStop },
    { id: "forward", label: "skipForward", icon: SkipForward, primary: false, disabled: seekLocked || !usable, run: () => onSeek(Math.min(duration, position + skipSeconds)) }
  ] satisfies readonly { id: string; label: MessageKey; icon: LucideIcon; primary: boolean; disabled: boolean; run(): void }[];
  const metrics: Metric[] = [
    {
      id: "speed",
      label: "practiceSpeed",
      value: tempoBpm === null ? "— BPM" : `${tempoBpm} BPM`,
      tone: "var(--color-primary)",
      previous: { icon: Minus, label: "speedDown", disabled: locked || tempoBpm === null || speed <= minPlaybackRate, run: () => changeTempo(-tempoStepBpm) },
      next: { icon: Plus, label: "speedUp", disabled: locked || tempoBpm === null || speed >= maxPlaybackRate, run: () => changeTempo(tempoStepBpm) }
    },
    {
      id: "key",
      label: "keyTranspose",
      value: keyShift > 0 ? `+${keyShift}` : String(keyShift),
      tone: "var(--color-success)",
      previous: { icon: ChevronLeft, label: "transposeDown", disabled: locked || keyShift <= -maxKeyShift, run: () => onKeyChange(-1) },
      next: { icon: ChevronRight, label: "transposeUp", disabled: locked || keyShift >= maxKeyShift, run: () => onKeyChange(1) }
    },
    { id: "range", label: "vocalRange", value: rangeLabel(range, keyShift), tone: "var(--color-warning)" }
  ];

  return (
    <div className="consoleCenter">
      <div className="transport" role="toolbar" aria-label={t("transportControls")}>
        {transport.map(action => (
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
      <div className="metrics">
        {metrics.map(metric => (
          <MetricCard key={metric.id} metric={metric} />
        ))}
      </div>
    </div>
  );
};
