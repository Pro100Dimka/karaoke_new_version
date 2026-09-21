import { forwardRef, type ElementType, type InputHTMLAttributes } from "react";
import cx from "../_internal/cx";
import mergeSx from "../_internal/sx";
import type { ControlSize, StyleVars } from "../_internal/types";

interface InputBaseOwnProps {
  component?: ElementType;
  className?: string;
  sx?: StyleVars;
  style?: StyleVars;
  disabled?: boolean;
  error?: boolean;
  size?: ControlSize;
  tone?: string;
  disableNativeDisabled?: boolean;
  /** Forwarded to a Button component when the base renders one. */
  unstyled?: boolean;
  rows?: number;
}

export type InputBaseProps = InputBaseOwnProps &
  Omit<InputHTMLAttributes<HTMLInputElement>, keyof InputBaseOwnProps | "size" | "style">;

const InputBase = forwardRef<HTMLElement, InputBaseProps>(
  (
    { component: Component = "input", className, sx, style, disabled, error, size = "md", tone, disableNativeDisabled = false, ...props },
    ref
  ) => (
    <Component
      ref={ref}
      className={cx(className)}
      style={mergeSx(sx, style)}
      data-size={size}
      {...(tone !== undefined && { "data-tone": tone })}
      {...(disabled && { "data-disabled": true })}
      {...(error && { "data-error": true })}
      {...(!disableNativeDisabled && { disabled })}
      {...props}
    />
  )
);

InputBase.displayName = "InputBase";
export default InputBase;
