import type { LucideIcon } from "lucide-react";
import { forwardRef, type CSSProperties } from "react";
import Button, { type ButtonProps } from "../Button";
import cx from "../_internal/cx";
import "./icon-button.css";

const CONTROL_SIZES = { xs: 24, sm: 32, md: 36, lg: 40, xl: 48 } as const;

export interface IconButtonProps extends Omit<ButtonProps, "size"> {
  icon?: LucideIcon;
  size?: keyof typeof CONTROL_SIZES;
  iconSize?: number;
  label?: string;
}

const IconButton = forwardRef<HTMLElement, IconButtonProps>(
  (
    { icon: Icon, size = "md", iconSize, unstyled = false, className, children, "aria-label": ariaLabel, label, title, ...props },
    ref
  ) => {
    const accessibleLabel = ariaLabel ?? label ?? title;
    const buttonSize = iconSize ?? CONTROL_SIZES[size];
    const actualIconSize = buttonSize * 0.45;
    const style = { "--control-size": `${buttonSize}px` } as CSSProperties;

    return (
      <Button
        ref={ref}
        size={size}
        unstyled={unstyled}
        className={unstyled ? className : cx("ui-icon-button", className)}
        aria-label={accessibleLabel}
        title={title ?? accessibleLabel}
        style={style}
        {...props}
      >
        {Icon ? <Icon size={actualIconSize} aria-hidden="true" /> : children}
      </Button>
    );
  }
);

IconButton.displayName = "IconButton";
export default IconButton;
