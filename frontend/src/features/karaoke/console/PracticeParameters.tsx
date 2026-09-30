import { ChevronLeft, ChevronRight, Settings, type LucideIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { MessageKey } from "../../../i18n/messages";
import { useText } from "../../../i18n/useText";
import { Card, IconButton, NumberField, Typography } from "../../../theme/ui";
import { ConsoleSection } from "./ConsoleSection";
import { rangeLabel, type NoteRange } from "./noteRange";

const maxKeyShift = 12;
export const minPlaybackRate = 0.5;
export const maxPlaybackRate = 1.5;

interface StepAction {
  icon: LucideIcon;
  label: MessageKey;
  disabled: boolean;
  run(): void;
}

interface Metric {
  id: string;
  label: MessageKey;
  value: ReactNode;
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
          {typeof metric.value === "string" ? (
            <Typography variant="body2">
              <strong>{metric.value}</strong>
            </Typography>
          ) : metric.value}
          {step(metric.next)}
        </div>
      </div>
    </Card>
  );
};

interface PracticeParametersProps {
  speed: number;
  baseBpm?: number;
  keyShift: number;
  keyLabel: string;
  range: NoteRange | null;
  locked: boolean;
  onSpeedChange(value: number): void;
  onKeyChange(delta: number): void;
}

interface TempoFieldProps {
  baseBpm: number | null;
  tempoBpm: number | null;
  locked: boolean;
  onChange(value: number): void;
}

const TempoField = ({ baseBpm, tempoBpm, locked, onChange }: TempoFieldProps) => {
  const t = useText();
  const shownValue = tempoBpm === null ? "" : String(tempoBpm);
  const [draft, setDraft] = useState(shownValue);

  useEffect(() => setDraft(shownValue), [shownValue]);

  const commit = () => {
    if (baseBpm === null || tempoBpm === null) return;
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(shownValue);
      return;
    }
    const minimum = Math.ceil(baseBpm * minPlaybackRate);
    const maximum = Math.floor(baseBpm * maxPlaybackRate);
    const nextBpm = Math.max(minimum, Math.min(maximum, Math.round(parsed)));
    setDraft(String(nextBpm));
    if (nextBpm !== tempoBpm) onChange(nextBpm / baseBpm);
  };

  return (
    <div className="tempoField">
      <NumberField
        aria-label={t("practiceSpeed")}
        className="tempoNumberField"
        inputClassName="tempoNumberFieldInput"
        value={draft}
        min={baseBpm === null ? undefined : Math.ceil(baseBpm * minPlaybackRate)}
        max={baseBpm === null ? undefined : Math.floor(baseBpm * maxPlaybackRate)}
        step={1}
        controls={false}
        disabled={locked || baseBpm === null}
        placeholder="—"
        onChange={setDraft}
        onBlur={commit}
        onKeyDown={event => {
          if (event.key !== "Enter") return;
          event.currentTarget.blur();
        }}
      />
      <span aria-hidden="true">BPM</span>
    </div>
  );
};

/** The three practice read-outs: tempo, key and the vocal range of the song. */
export const PracticeParameters = ({ speed, baseBpm, keyShift, keyLabel, range, locked, onSpeedChange, onKeyChange }: PracticeParametersProps) => {
  const t = useText();
  const validBaseBpm = typeof baseBpm === "number" && Number.isFinite(baseBpm) && baseBpm > 0 ? baseBpm : null;
  const tempoBpm = validBaseBpm === null ? null : Math.round(validBaseBpm * speed);
  const metrics: Metric[] = [
    {
      id: "speed",
      label: "practiceSpeed",
      value: <TempoField baseBpm={validBaseBpm} tempoBpm={tempoBpm} locked={locked} onChange={onSpeedChange} />,
      tone: "var(--color-primary)",
    },
    {
      id: "key",
      label: "keyTranspose",
      value: keyLabel,
      tone: "var(--color-success)",
      previous: { icon: ChevronLeft, label: "transposeDown", disabled: locked || keyShift <= -maxKeyShift, run: () => onKeyChange(-1) },
      next: { icon: ChevronRight, label: "transposeUp", disabled: locked || keyShift >= maxKeyShift, run: () => onKeyChange(1) }
    },
    { id: "range", label: "vocalRange", value: rangeLabel(range, keyShift), tone: "var(--color-warning)" }
  ];

  return (
    <ConsoleSection icon={Settings} title={t("consoleParameters")}>
      <div className="metrics">
        {metrics.map(metric => (
          <MetricCard key={metric.id} metric={metric} />
        ))}
      </div>
    </ConsoleSection>
  );
};
