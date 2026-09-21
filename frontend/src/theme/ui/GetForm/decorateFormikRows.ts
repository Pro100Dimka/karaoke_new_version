import type { FormRow, FormState } from "./types";

/** Attaches the form state to every row and disables rows while the form is submitting. */
export default function decorateFormikRows(items: readonly FormRow[], formik: FormState | undefined): FormRow[] {
  return items.map(item => ({
    ...item,
    formik: item.formik ?? formik,
    ...(item.type === "Text" && { fontWeight: item.fontWeight ?? 500 }),
    disabled: Boolean(formik?.isSubmitting) || item.disabled
  }));
}
