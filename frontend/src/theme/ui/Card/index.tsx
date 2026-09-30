import { forwardRef, type ComponentPropsWithoutRef, type ElementType, type HTMLAttributes, type ReactNode } from "react";
import { AnimatedNeonFrame } from "../../../shared/ui/AnimatedNeonFrame";
import Primitive from "../_internal/Primitive";
import cx from "../_internal/cx";
import type { StyleVars } from "../_internal/types";
import "./card.css";
import useCardTilt from "./useCardTilt";

export type CardVariant = "neon" | "animation" | "aurora" | "laser";
const NEON_VARIANTS: readonly string[] = ["neon", "animation", "aurora", "laser"];

export interface CardProps extends Omit<ComponentPropsWithoutRef<"section">, "style"> {
  as?: ElementType;
  surface?: string;
  variant?: CardVariant | (string & {});
  elevation?: 0 | 1 | 2 | 3 | 4;
  interactive?: boolean;
  loading?: boolean;
  tilt?: boolean;
  cardContent?: HTMLAttributes<HTMLDivElement>;
  cardPanel?: HTMLAttributes<HTMLDivElement>;
  overlay?: ReactNode;
  neonFrame?: ReactNode;
  sx?: StyleVars;
  style?: StyleVars;
  disablePadding?: boolean;
}

const Card = forwardRef<HTMLElement, CardProps>(
  (
    {
      as = "section",
      surface = "base",
      variant,
      elevation = 0,
      interactive = false,
      loading = false,
      tilt = true,
      cardContent,
      cardPanel,
      overlay,
      neonFrame,
      className,
      sx,
      disablePadding,
      style,
      children,
      onPointerMove,
      onPointerLeave,
      ...props
    },
    ref
  ) => {
    const isNeon = variant !== undefined && NEON_VARIANTS.includes(variant);
    const { handlePointerMove, handlePointerLeave } = useCardTilt<HTMLElement>({
      isNeon,
      tilt,
      extraPositionVars: [["--glow-x", "--glow-y"]],
      onPointerMove,
      onPointerLeave
    });

    return (
      <Primitive
        ref={ref}
        as={as}
        className={cx("ui-card", isNeon && "ui-card--neon", !tilt && "ui-card--no-tilt", className)}
        data-surface={surface}
        data-variant={variant || undefined}
        data-interactive={interactive || undefined}
        data-loading={loading || undefined}
        sx={sx}
        style={{
          "--card-shadow": `var(--shadows-${elevation})`,
          ...(isNeon && { overflow: "visible", border: 0, background: "transparent" }),
          ...style,
          ...(disablePadding && { padding: 0 })
        }}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        {...props}
      >
        {isNeon ? (
          <>
            {neonFrame ?? <AnimatedNeonFrame className="ui-card__frame" />}
            <div {...cardPanel} className={cx("ui-card__panel", cardPanel?.className)}>
              <span className="ui-card__fx ui-card__sheen" aria-hidden="true" />
              <div {...cardContent} className={cx("ui-card__content", cardContent?.className)}>
                {children}
              </div>
            </div>
            {overlay}
          </>
        ) : (
          <>
            {children}
            {overlay}
          </>
        )}
      </Primitive>
    );
  }
);

Card.displayName = "Card";
export default Card;
