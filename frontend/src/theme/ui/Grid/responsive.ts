import type { StyleVars } from "../_internal/types";

/** Default viewport breakpoints; keep grid.css media queries in sync. */
export const GRID_BREAKPOINTS = { xs: 0, sm: 600, md: 900, lg: 1200, xl: 1536 } as const;
type Point = keyof typeof GRID_BREAKPOINTS;
export type Responsive<T> = Partial<Record<Point, T>>;

const points = Object.keys(GRID_BREAKPOINTS) as Point[];
const isMap = <T,>(value: unknown): value is Responsive<T> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;

function responsiveVars(
  prefix: string,
  values: Responsive<number> | undefined,
  initial: string | number,
  format: (value: number | undefined) => string | number | undefined
): StyleVars {
  let previous = initial;
  const vars: Record<string, string | number> = {};
  for (const point of points) {
    const next = format(values?.[point]);
    if (next != null) previous = next;
    vars[`${prefix}-${point}`] = previous;
  }
  return vars as StyleVars;
}

export function gridColumnStyles(columns: number | string | Responsive<number> | undefined, fallback: number): StyleVars {
  const responsive = isMap<number>(columns);
  const base = !responsive && (isCount(columns) || typeof columns === "string") ? columns : fallback;
  return {
    "--grid-columns": base,
    ...responsiveVars("--grid-columns", responsive ? columns : undefined, "var(--grid-columns)", value =>
      isCount(value) ? value : undefined
    )
  };
}

export function gridItemStyles(
  size: number | Responsive<number> | undefined,
  breakpoints: Responsive<number>
): { sized: boolean; style: StyleVars } {
  const sizes: Responsive<number> = isMap<number>(size) ? { ...size } : { xs: size as number | undefined };
  for (const point of points) {
    const value = breakpoints[point];
    if (value != null) sizes[point] = value;
  }
  const sized = Object.values(sizes).some(isCount);
  return {
    sized,
    style: responsiveVars("--grid-item-column", sizes, "auto", value => (isCount(value) ? `span ${value}` : undefined))
  };
}
