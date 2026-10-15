import {
  Grid,
  IconButton,
  Select,
  Stack,
  Switch,
  Tooltip,
  Typography,
  type FormApi,
} from "@neo-ui-kit/react";
import type { AudioField } from "./audioRows";
import type { AudioValues } from "./settingsModel";

const numeric = new Set<keyof AudioValues>([
  "sampleRate",
  "periodFrames",
  "bufferFrames",
]);

/**
 * The device form: every change goes into the form and is committed at once, so the new
 * configuration is applied without an "apply" button. The value AudioService really runs
 * with is shown under each select.
 */
export const AudioFields = <T extends AudioValues>({
  fields,
  form,
  onCommit,
  columns,
  showDescriptions = true,
}: {
  fields: readonly AudioField[];
  form: FormApi<T>;
  onCommit(name: string, value: unknown): void;
  columns?: number;
  showDescriptions?: boolean;
}) => {
  const control = (field: AudioField) => {
    if (field.kind === "switch")
      return field.description ? (
        <Stack key={field.key} gap="0.25rem">
          <Stack direction="row" gap={2} align="center">
            <Switch
              label={field.label}
              checked={field.checked}
              onValueChange={field.onChange}
            />
            <Tooltip content={field.hint}>
              <IconButton
                size="sm"
                variant="ghost"
                icon="info"
                label={field.hint}
              />
            </Tooltip>
          </Stack>
          <Typography className="audioFieldDescription" variant="caption" tone="muted">
            {field.description}
          </Typography>
        </Stack>
      ) : (
        <Tooltip key={field.key} content={field.hint}>
          <Switch
            label={field.label}
            checked={field.checked}
            onValueChange={field.onChange}
          />
        </Tooltip>
      );
    if (field.kind === "action")
      return (
        <Stack key={field.key} gap="0.25rem" align="center">
          <Tooltip content={field.label}>
            <IconButton
              round
              size="lg"
              icon="play"
              label={field.label}
              disabled={field.disabled}
              onClick={field.onClick}
            />
          </Tooltip>
          <Typography variant="caption" tone="muted">
            {field.label}
          </Typography>
        </Stack>
      );
    const commit = (raw: string) => {
      const value = numeric.has(field.tag) ? Number(raw) : raw;
      form.setValue(field.tag, value);
      onCommit(field.tag, value);
    };
    return (
      <Select
        key={field.tag}
        label={field.label}
        description={showDescriptions ? field.hint : undefined}
        error={field.error}
        value={String(form.values[field.tag])}
        options={field.options.map((option) => ({
          value: String(option.value),
          label: option.label,
        }))}
        onValueChange={commit}
      />
    );
  };
  // Device actions share the select row; switches form the separated row below it.
  const selects = fields.filter((field) => field.kind === "select");
  const actions = fields.filter((field) => field.kind === "action");
  const switches = fields.filter((field) => field.kind === "switch");
  return (
    <div className="settingsStack">
      {(selects.length > 0 || actions.length > 0) && (
        <div className={`audioFieldsTopRow${actions.length ? " audioFieldsWithActions" : ""}`}>
          <Grid
            columns={columns}
            minChildWidth={columns ? undefined : "min(100%, 13rem)"}
            gap={4}
            align={showDescriptions ? "start" : "end"}
          >
            {selects.map(control)}
          </Grid>
          {actions.map(control)}
        </div>
      )}
      {switches.length > 0 && (
        <Stack
          direction="row"
          gap="var(--ad-space-3) var(--ad-space-6)"
          align="center"
          wrap
        >
          {switches.map(control)}
        </Stack>
      )}
    </div>
  );
};
