import { FormikProvider, type FormikProps } from "formik";
import type { FormHTMLAttributes, ReactNode } from "react";
import RenderFormikFields, { type RenderFormikFieldsProps } from "./RenderFormikFields";
import type { FormRow, FormState } from "./types";

export { default as decorateFormikRows } from "./decorateFormikRows";
export { default as mergeProperties } from "./mergeProperties";
export { default as RenderFormikFields } from "./RenderFormikFields";
export { default as useGetForm } from "./useGetForm";
export type { ControlComponent } from "./fieldKinds";
export type { FormRow, FormState, FormValues } from "./types";

interface GetFormProps<Values extends object> extends Omit<FormHTMLAttributes<HTMLFormElement>, "children"> {
  formik: FormikProps<Values>;
  items?: readonly FormRow[];
  components?: RenderFormikFieldsProps<Values>["components"];
  onFieldCommit?: RenderFormikFieldsProps<Values>["onFieldCommit"];
  pickFolder?: RenderFormikFieldsProps<Values>["pickFolder"];
  showForProps?: unknown;
  gridProps?: Omit<RenderFormikFieldsProps<Values>, "formik" | "items" | "components" | "onFieldCommit" | "pickFolder" | "showForProps" | "children">;
  children?: ReactNode | ((formik: FormikProps<Values>) => ReactNode);
}

/** A <form> wired to Formik that renders `items` as themed fields; extra children render after the fields. */
export default function GetForm<Values extends object>({ formik, items = [], components, onFieldCommit, pickFolder, showForProps, gridProps, children, ...props }: GetFormProps<Values>) {
  return (
    <FormikProvider value={formik}>
      <form noValidate {...props} onSubmit={formik.handleSubmit} onReset={formik.handleReset}>
        <RenderFormikFields
          {...gridProps}
          formik={formik}
          items={items}
          components={components}
          onFieldCommit={onFieldCommit}
          pickFolder={pickFolder}
          showForProps={showForProps}
        >
          {typeof children === "function" ? children(formik) : children}
        </RenderFormikFields>
      </form>
    </FormikProvider>
  );
}
