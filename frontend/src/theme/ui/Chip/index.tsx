import type { ComponentPropsWithoutRef, ElementType, MouseEvent } from "react";
import { useText } from "../../../i18n/useText";
import Primitive from "../_internal/Primitive";
import "./chip.css";

export interface ChipProps extends Omit<ComponentPropsWithoutRef<"span">, "color"> {
  as?: ElementType;
  tone?: string;
  variant?: string;
  size?: "sm" | "md";
  selected?: boolean;
  removable?: boolean;
  onRemove?: (event: MouseEvent<HTMLButtonElement>) => void;
}

export default function Chip({
  as = "span",
  tone = "default",
  variant = "soft",
  size = "md",
  selected = false,
  removable = false,
  onRemove,
  className = "",
  children,
  ...props
}: ChipProps) {
  const t = useText();
  return (
    <Primitive
      as={as}
      className={`ui-chip ${className}`.trim()}
      data-tone={tone}
      data-variant={variant}
      data-size={size}
      data-selected={selected || undefined}
      {...props}
    >
      {children}
      {removable && (
        <button
          type="button"
          className="ui-chip-remove"
          aria-label={t("removeItem")}
          onClick={event => {
            event.stopPropagation();
            onRemove?.(event);
          }}
        >
          ×
        </button>
      )}
    </Primitive>
  );
}
