import { useEffect, useState, type ReactNode } from "react";
import { Card, IconButton, NumberField, Stack, Typography } from "@ad-voice/ui";
import type { MessageKey } from "../../../i18n/messages";
import { useText } from "../../../i18n/useText";
import { ConsoleSection } from "./ConsoleSection";
import { rangeLabel, type NoteRange } from "./noteRange";

const maxKeyShift = 12;
export const minPlaybackRate = 0.5;
export const maxPlaybackRate = 1.5;

interface StepAction {
  icon: string;
  label: MessageKey;
  disabled: boolean;
  run(): void;
}

interface Metric {
  id: string;
  label: MessageKey;
  value: ReactNode;
  previous?: StepAction;
  next?: StepAction;
}

const MetricCard = ({ metric }: { metric: Metric }) => {
  const t = useText();
  const step = (action: StepAction | undefined) =>
    action && <IconButton size="xs" round icon={action.icon} label={t(action.label)} disabled={action.disabled} onClick={action.run} />;
  return (
    <Card material="glass" padding="sm" className="metricCard">
      <Typography variant="caption" tone="muted">{t(metric.label)}</Typography>
      <Stack direction="row" gap={2} align="center" justify="end">
        {step(metric.previous)}
        {typeof metric.value === "string" ? <Typography as="strong" variant="title">{metric.value}</Typography> : metric.value}
        {step(metric.next)}
      </Stack>
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

/** The tempo in BPM, applied when typing ends (Enter or leaving the field), kept within the playable speeds. */
const TempoField = ({ baseBpm, tempoBpm, locked, onChange }: {
  baseBpm: number | null;
  tempoBpm: number | null;
  locked: boolean;
  onChange(value: number): void;
}) => {
  const t = useText();
  const [draft, setDraft] = useState<number | "">(tempoBpm ?? "");
  useEffect(() => setDraft(tempoBpm ?? ""), [tempoBpm]);
  const minimum = baseBpm === null ? undefined : Math.ceil(baseBpm * minPlaybackRate);
  const maximum = baseBpm === null ? undefined : Math.floor(baseBpm * maxPlaybackRate);

  const commit = () => {
    if (baseBpm === null || tempoBpm === null || minimum === undefined || maximum === undefined) return;
    if (draft === "") return setDraft(tempoBpm);
    const next = Math.max(minimum, Math.min(maximum, Math.round(draft)));
    setDraft(next);
    if (next !== tempoBpm) onChange(next / baseBpm);
  };

  return (
    <NumberField size="sm" className="tempoField" aria-label={t("practiceSpeed")} controls={false} value={draft}
      min={minimum} max={maximum} step={1} disabled={locked || baseBpm === null} placeholder="—"
      endAdornment={<Typography variant="caption" tone="muted">BPM</Typography>}
      onValueChange={setDraft} onBlur={commit}
      onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />
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
    },
    {
      id: "key",
      label: "keyTranspose",
      value: keyLabel,
      previous: { icon: "minus", label: "transposeDown", disabled: locked || keyShift <= -maxKeyShift, run: () => onKeyChange(-1) },
      next: { icon: "plus", label: "transposeUp", disabled: locked || keyShift >= maxKeyShift, run: () => onKeyChange(1) },
    },
    { id: "range", label: "vocalRange", value: rangeLabel(range, keyShift) },
  ];

  return (
    <ConsoleSection icon="settings" title={t("consoleParameters")}>
      <div className="metrics">
        {metrics.map(metric => <MetricCard key={metric.id} metric={metric} />)}
      </div>
    </ConsoleSection>
  );
};
