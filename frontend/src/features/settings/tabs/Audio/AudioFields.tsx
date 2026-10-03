import type { FormikProps } from "formik";
import { Button, Grid, Select, Switch, Tooltip } from "@ad-voice/ui";
import type { AudioField } from "./audioRows";
import type { AudioValues } from "./settingsModel";

const numeric = new Set<keyof AudioValues>(["sampleRate", "periodFrames", "bufferFrames"]);

/**
 * The device form: every change goes into the form and is committed at once, so the new
 * configuration is applied without an "apply" button. The value AudioService really runs
 * with is shown under each select.
 */
export const AudioFields = ({ fields, formik, onCommit }: {
  fields: readonly AudioField[];
  formik: FormikProps<AudioValues>;
  onCommit(name: string, value: unknown): void;
}) => (
  <Grid minChildWidth="min(100%, 14rem)" gap={4} align="end">
    {fields.map(field => {
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
        void formik.setFieldValue(field.tag, value, false);
        onCommit(field.tag, value);
      };
      return (
        <Select key={field.tag} label={field.label} description={field.hint} error={field.error}
          value={String(formik.values[field.tag])}
          options={field.options.map(option => ({ value: String(option.value), label: option.label }))}
          onValueChange={commit} />
      );
    })}
  </Grid>
);
