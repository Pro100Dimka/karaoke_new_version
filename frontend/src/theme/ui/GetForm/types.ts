import type { FormikProps } from "formik";
import type { ReactNode } from "react";
import type { StyleVars } from "../_internal/types";

export type FormValues = Record<string, unknown>;
export type FormState = FormikProps<FormValues>;

/** One field of a data-driven form. Unknown keys are passed to the rendered control (label, options, min, ...). */
export interface FormRow {
  /** Control kind (see aliases in RenderFormikFields) or a key of the `components` map. */
  type?: string;
  /** Path into the form values, e.g. "audio.sampleRate". */
  tag?: string;
  name?: string;
  formik?: FormState;
  key?: string;
  parse?(raw: unknown, state: FormState): unknown;
  onChange?(value: unknown, event?: unknown): void;
  onBlur?(event?: unknown): void;
  onCommit?(value: unknown): void;
  /** Persists a value as soon as it is committed (blur for text-like fields, change otherwise). */
  onSave?(value: unknown): Promise<void> | void;
  saveOn?: "blur" | "change" | false;
  valueType?: "number" | "nullable-number";
  validate?(value: unknown): string | undefined | Promise<string | undefined>;
  inputType?: string;
  fontWeight?: number | string;
  children?: ReactNode;
  render?(props: Record<string, unknown>): ReactNode;
  fieldProps?: Record<string, unknown>;
  xs?: number;
  sm?: number;
  md?: number;
  lg?: number;
  xl?: number;
  showFor?: boolean | ((values: unknown) => boolean);
  gSx?: StyleVars;
  [key: string]: unknown;
}
