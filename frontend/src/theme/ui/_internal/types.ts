import type { CSSProperties } from "react";

/** Inline style that may also carry CSS custom properties such as "--slider-value". */
export type StyleVars = CSSProperties & { [name: `--${string}`]: string | number | undefined };

export type ControlSize = "xs" | "sm" | "md" | "lg";
export type SelectOption<T extends string | number = string | number> = {
  value: T;
  label: string;
  disabled?: boolean;
  group?: string;
  description?: string;
  icon?: import("react").ReactNode;
};
