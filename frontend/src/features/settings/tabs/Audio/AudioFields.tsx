import { Button, Grid, Select, Switch, Tooltip, type FormApi } from "@ad-voice/ui";
import type { AudioField } from "./audioRows";
import type { AudioValues } from "./settingsModel";

const numeric = new Set<keyof AudioValues>(["sampleRate", "periodFrames", "bufferFrames"]);

/**
 * The device form: every change goes into the form and is committed at once, so the new
 * configuration is applied without an "apply" button. The value AudioService really runs
 * with is shown under each select.
 */
export const AudioFields = ({ fields, form, onCommit }: {
  fields: readonly AudioField[];
  form: FormApi<AudioValues>;
  onCommit(name: string, value: unknown): void;
}) => {
  const control = (field: AudioField) => {
    if (field.kind === "switch")
      return (
        <Tooltip key={field.key} content={field.hint}>
          <Switch label={field.label} checked={field.checked} onValueChange={field.onChange} />
        </Tooltip>
      );
    if (field.kind === "action")
      return <Button key={field.key} icon="play" disabled={field.disabled} onClick={field.onClick}>{field.label}</Button>;
    const commit = (raw: string) => {
      const value = numeric.has(field.tag) ? Number(raw) : raw;
      form.setValue(field.tag, value);
      onCommit(field.tag, value);
    };
    return (
      <Select key={field.tag} label={field.label} description={field.hint} error={field.error}
        value={String(form.values[field.tag])}
        options={field.options.map(option => ({ value: String(option.value), label: option.label }))}
        onValueChange={commit} />
    );
  };
  // Selects line up by their labels; switches and buttons follow in one row of their own.
  const selects = fields.filter(field => field.kind === "select");
  const inline = fields.filter(field => field.kind !== "select");
  return (
    <div className="settingsStack">
      <Grid minChildWidth="min(100%, 14rem)" gap={4} align="start">{selects.map(control)}</Grid>
      {inline.length > 0 && <div className="audioInlineFields">{inline.map(control)}</div>}
    </div>
  );
};
