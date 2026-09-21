import type { ComponentPropsWithoutRef, ElementType } from "react";
import Primitive from "../_internal/Primitive";
import cx from "../_internal/cx";
import type { StyleVars } from "../_internal/types";
import "./typography.css";

const TAGS = { h1: "h1", h2: "h2", h3: "h3", body1: "p", body2: "p", caption: "span" } as const;
export type TypographyVariant = keyof typeof TAGS;

export interface TypographyProps extends Omit<ComponentPropsWithoutRef<"p">, "style"> {
  as?: ElementType;
  variant?: TypographyVariant;
  tone?: "primary" | "muted" | "soft" | "danger" | "success" | "warning" | (string & {});
  align?: "left" | "center" | "right";
  noWrap?: boolean;
  style?: StyleVars;
}

export default function Typography({
  as,
  variant = "body1",
  tone = "primary",
  align,
  noWrap = false,
  className,
  style,
  ...props
}: TypographyProps) {
  return (
    <Primitive
      as={as || TAGS[variant]}
      className={cx("ui-typography", className)}
      data-variant={variant}
      data-tone={tone}
      data-nowrap={noWrap || undefined}
      style={{ "--typography-align": align, ...style }}
      {...props}
    />
  );
}
