import { forwardRef, type ComponentPropsWithoutRef, type ElementType } from "react";
import Primitive from "../_internal/Primitive";
import cx from "../_internal/cx";
import type { StyleVars } from "../_internal/types";
import "./stack.css";

const unit = (value: number | string): string => (typeof value === "number" ? `${value}rem` : value);

export interface StackProps extends Omit<ComponentPropsWithoutRef<"div">, "style"> {
  as?: ElementType;
  direction?: "row" | "column" | "row-reverse" | "column-reverse";
  gap?: number | string;
  align?: string;
  justify?: string;
  wrap?: boolean;
  sx?: StyleVars;
  style?: StyleVars;
}

const Stack = forwardRef<HTMLElement, StackProps>(function Stack(
  { as = "div", direction = "column", gap = 0, align, justify, wrap = false, className, sx, style, ...props },
  ref
) {
  return (
    <Primitive
      ref={ref}
      as={as}
      className={cx("ui-stack", className)}
      sx={sx}
      style={{
        "--stack-direction": direction,
        "--stack-gap": unit(gap),
        "--stack-align": align ?? "stretch",
        "--stack-justify": justify ?? "flex-start",
        "--stack-wrap": wrap ? "wrap" : "nowrap",
        ...style
      }}
      {...props}
    />
  );
});

export default Stack;
