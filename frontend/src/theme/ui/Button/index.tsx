import { forwardRef, type ComponentPropsWithoutRef, type ElementType, type MouseEvent, type ReactNode } from "react";
import Primitive, { type PrimitiveProps } from "../_internal/Primitive";
import cx from "../_internal/cx";
import type { ControlSize } from "../_internal/types";
import "./button.css";

export type ButtonVariant = "contained" | "outlined" | "outline" | "ghost";
export type ButtonTone = "primary" | "secondary" | "neutral" | "danger" | "success" | "warning";

export interface ButtonProps extends Omit<ComponentPropsWithoutRef<"button">, "color"> {
  as?: ElementType;
  variant?: ButtonVariant;
  tone?: ButtonTone;
  size?: ControlSize | "xl";
  unstyled?: boolean;
  fullWidth?: boolean;
  startIcon?: ReactNode;
}

const Button = forwardRef<HTMLElement, ButtonProps>(
  (
    {
      as = "button",
      type = "button",
      variant = "contained",
      tone = "primary",
      size = "md",
      unstyled = false,
      disabled = false,
      fullWidth = false,
      startIcon,
      children,
      className,
      onClick,
      tabIndex,
      ...props
    },
    ref
  ) => {
    const native = as === "button";

    const click = (event: MouseEvent<HTMLElement>) => {
      if (!native && disabled) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      onClick?.(event as MouseEvent<HTMLButtonElement>);
    };

    return (
      <Primitive
        ref={ref}
        as={as}
        type={native ? type : undefined}
        className={
          unstyled
            ? className
            : cx(
                "ui-button",
                "ui-control",
                "ui-focus-ring",
                "ui-disabled",
                "ui-motion",
                fullWidth && "ui-button-full-width",
                className
              )
        }
        data-variant={unstyled ? undefined : variant}
        data-tone={unstyled ? undefined : tone}
        data-size={unstyled ? undefined : size}
        disabled={native ? disabled : undefined}
        aria-disabled={!native && disabled ? true : undefined}
        tabIndex={!native && disabled ? -1 : tabIndex}
        onClick={click}
        {...(props as PrimitiveProps)}
      >
        {startIcon && (
          <span className="ui-button-start-icon" aria-hidden="true">
            {startIcon}
          </span>
        )}
        {children}
      </Primitive>
    );
  }
);

Button.displayName = "Button";
export default Button;
