import type { ComponentPropsWithoutRef, ElementType } from "react";
import Primitive from "../_internal/Primitive";
import cx from "../_internal/cx";
import type { StyleVars } from "../_internal/types";
import "./grid.css";
import { gridColumnStyles, gridItemStyles, type Responsive } from "./responsive";

const unit = (value: number | string): string => (typeof value === "number" ? `${value}px` : value);

export interface GridProps extends Omit<ComponentPropsWithoutRef<"div">, "style"> {
  as?: ElementType;
  columns?: number | string | Responsive<number>;
  container?: boolean;
  item?: boolean;
  size?: number | Responsive<number>;
  xs?: number;
  sm?: number;
  md?: number;
  lg?: number;
  xl?: number;
  gap?: number | string;
  rowGap?: number | string;
  columnGap?: number | string;
  minItemWidth?: number | string;
  collapseEmpty?: boolean;
  align?: string;
  justify?: string;
  sx?: StyleVars;
  style?: StyleVars;
}

export default function Grid({
  as = "div",
  columns,
  container = false,
  item = false,
  size,
  xs,
  sm,
  md,
  lg,
  xl,
  gap = 0,
  rowGap,
  columnGap,
  minItemWidth = "min(100%, 16rem)",
  collapseEmpty = true,
  align,
  justify,
  className,
  sx,
  style,
  ...props
}: GridProps) {
  const sizing = gridItemStyles(size, { xs, sm, md, lg, xl });
  const isItem = item || sizing.sized;
  const isContainer = container || columns != null || !isItem;
  const adaptive = isContainer && !container && columns == null;

  return (
    <Primitive
      as={as}
      className={cx("ui-grid", className)}
      data-grid-item={isItem || undefined}
      data-grid-container={isContainer || undefined}
      data-adaptive={adaptive || undefined}
      data-collapse-empty={adaptive && collapseEmpty ? "true" : "false"}
      sx={sx}
      style={{
        ...gridColumnStyles(columns, container ? 12 : 1),
        ...sizing.style,
        "--grid-gap": unit(gap),
        "--grid-row-gap": unit(rowGap ?? gap),
        "--grid-column-gap": unit(columnGap ?? gap),
        "--grid-min-item-width": typeof minItemWidth === "number" ? `${minItemWidth}px` : minItemWidth,
        "--grid-align": align ?? "stretch",
        "--grid-justify": justify ?? "stretch",
        ...style
      }}
      {...props}
    />
  );
}
