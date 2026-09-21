import { FormikContext, type FormikProps } from "formik";
import { Suspense, useContext, type ReactNode } from "react";
import { useText } from "../../../i18n/useText";
import Grid, { type GridProps } from "../Grid";
import { Field, type PickFolder } from "./Field";
import { breakpoints, type ControlComponent } from "./fieldKinds";
import decorateFormikRows from "./decorateFormikRows";
import type { FormRow, FormState } from "./types";
import type { FieldCommit } from "./useFieldBinding";
import "./get-form.css";

const gridUnitPixels = 8;

/** Rows without an identity of their own (labels, buttons) are keyed by kind and position in the fixed list. */
const rowKey = (row: FormRow, position: number): string => row.key ?? row.tag ?? row.name ?? `${row.type ?? "row"}-${position}`;

export interface RenderFormikFieldsProps<Values extends object = object> extends Omit<GridProps, "items"> {
  items?: readonly FormRow[];
  formik?: FormikProps<Values>;
  components?: Readonly<Record<string, ControlComponent>>;
  onFieldCommit?: FieldCommit;
  pickFolder?: PickFolder;
  /** Values `showFor` predicates see; defaults to the form values. */
  showForProps?: unknown;
  spacing?: number;
  rowSpacing?: number;
  columnSpacing?: number;
  children?: ReactNode;
}

/** Column spans per breakpoint (12 by default; 0 hides the cell) and the display each breakpoint resolves to. */
const cellLayout = ({ xs, sm, md, lg, xl }: FormRow) => {
  const sizes: Record<string, number> = { xs: xs ?? 12 };
  for (const [point, span] of Object.entries({ sm, md, lg, xl })) if (span !== undefined) sizes[point] = span;
  let visible = "flex";
  const visibility = Object.fromEntries(
    breakpoints.map(point => {
      if (sizes[point] !== undefined) visible = sizes[point] === 0 ? "none" : "flex";
      return [`--get-form-display-${point}`, visible];
    })
  );
  return { sizes, visibility };
};

/** Renders a list of typed rows as a responsive grid of themed controls bound to Formik. */
export default function RenderFormikFields<Values extends object = object>({
  items = [],
  formik,
  components = {},
  onFieldCommit,
  pickFolder,
  showForProps,
  children,
  spacing = 2,
  rowSpacing = 3,
  columnSpacing = spacing,
  gap = spacing * gridUnitPixels,
  rowGap = rowSpacing * gridUnitPixels,
  columnGap = columnSpacing * gridUnitPixels,
  ...props
}: RenderFormikFieldsProps<Values>) {
  const t = useText();
  const context = useContext(FormikContext) as FormState | undefined;
  // Formik's typed helpers are contravariant in the values; the renderer only reads/writes by path.
  const state = (formik ?? context) as unknown as FormState | undefined;
  const rows = items.map(row => decorateFormikRows([row], row.formik ?? state)[0] as FormRow);

  return (
    <Grid {...props} container gap={gap} rowGap={rowGap} columnGap={columnGap}>
      {rows.map(({ gSx, showFor, ...row }, position) => {
        if (showFor !== undefined && !(typeof showFor === "function" ? showFor(showForProps ?? state?.values) : showFor)) return null;
        const { sizes, visibility } = cellLayout(row);
        return (
          <Grid item size={sizes} key={rowKey(row, position)} className="ui-get-form-cell" sx={gSx} style={visibility}>
            <Suspense fallback={<span role="status">{t("fieldLoading")}</span>}>
              <Field row={row} formik={state} components={components} onFieldCommit={onFieldCommit} pickFolder={pickFolder} />
            </Suspense>
          </Grid>
        );
      })}
      {children}
    </Grid>
  );
}
