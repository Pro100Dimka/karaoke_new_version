import type { HTMLAttributes } from "react";
import mergeSx from "../_internal/sx";
import type { StyleVars } from "../_internal/types";
import "./progress.css";

export interface ProgressProps extends Omit<HTMLAttributes<HTMLDivElement>, "style"> {
  /** Omit for an indeterminate bar. */
  value?: number | null;
  max?: number;
  size?: "sm" | "md" | "lg";
  sx?: StyleVars;
  style?: StyleVars;
}

export default function Progress({ value, max = 100, size = "md", className = "", sx, style, ...props }: ProgressProps) {
  const indeterminate = value == null;
  return (
    <div
      className={`ui-progress ${className}`.trim()}
      data-size={size}
      data-indeterminate={indeterminate || undefined}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={indeterminate ? undefined : value}
      style={mergeSx(
        { "--progress-value": indeterminate ? 0 : `${Math.max(0, Math.min(100, (value / max) * 100))}%`, ...sx },
        style
      )}
      {...props}
    />
  );
}
