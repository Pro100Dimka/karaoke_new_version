import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import Card, { type CardProps } from "../Card";
import mergeRefs from "../_internal/mergeRefs";
import "./popover.css";

export type PopoverPlacement = "bottom-start" | "bottom-end" | "top-start" | "top-end" | "right" | "left";
const MARGIN = 8;

export interface PopoverProps extends Omit<CardProps, "children"> {
  open: boolean;
  onClose?: (event: Event) => void;
  anchorRef?: RefObject<HTMLElement | null>;
  placement?: PopoverPlacement;
  offset?: number;
  portal?: boolean;
  children?: ReactNode;
}

const Popover = forwardRef<HTMLElement, PopoverProps>(
  ({ open, onClose, anchorRef, placement = "bottom-start", offset = 8, portal = true, children, className = "", style, ...props }, ref) => {
    const popoverRef = useRef<HTMLElement | null>(null);
    const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

    const updatePosition = useCallback(() => {
      const anchor = anchorRef?.current;
      const popover = popoverRef.current;
      if (!anchor || !popover) return;
      const a = anchor.getBoundingClientRect();
      const p = popover.getBoundingClientRect();
      let top = a.bottom + offset;
      let left = a.left;
      if (placement === "bottom-end") left = a.right - p.width;
      if (placement === "top-start" || placement === "top-end") {
        top = a.top - p.height - offset;
        if (placement === "top-end") left = a.right - p.width;
      }
      if (placement === "right" || placement === "left") {
        top = a.top + (a.height - p.height) / 2;
        left = placement === "right" ? a.right + offset : a.left - p.width - offset;
      }
      setPosition({
        top: Math.max(MARGIN, Math.min(top, window.innerHeight - p.height - MARGIN)),
        left: Math.max(MARGIN, Math.min(left, window.innerWidth - p.width - MARGIN))
      });
    }, [anchorRef, offset, placement]);

    useLayoutEffect(() => {
      if (!open || !anchorRef) return undefined;
      updatePosition();
      const observer = typeof ResizeObserver === "function" ? new ResizeObserver(updatePosition) : null;
      if (anchorRef.current) observer?.observe(anchorRef.current);
      if (popoverRef.current) observer?.observe(popoverRef.current);
      window.addEventListener("resize", updatePosition);
      window.addEventListener("scroll", updatePosition, true);
      return () => {
        observer?.disconnect();
        window.removeEventListener("resize", updatePosition);
        window.removeEventListener("scroll", updatePosition, true);
      };
    }, [anchorRef, open, updatePosition]);

    useEffect(() => {
      if (!open || !onClose) return undefined;

      const closeOutside = (event: PointerEvent) => {
        const target = event.target instanceof Element ? event.target : null;
        const layer = target?.closest<HTMLElement>(".ui-popover[id]");
        // A nested portal popover (e.g. a Select inside this one) must not count as an outside click.
        const owned = layer?.id
          ? [...(popoverRef.current?.querySelectorAll("[aria-controls]") ?? [])].some(
              control => control.getAttribute("aria-controls") === layer.id
            )
          : false;
        const inside = event.target instanceof Node && (popoverRef.current?.contains(event.target) || anchorRef?.current?.contains(event.target));
        if (!inside && !owned) onClose(event);
      };
      const closeOnEscape = (event: KeyboardEvent) => {
        if (event.key === "Escape") onClose(event);
      };

      document.addEventListener("pointerdown", closeOutside, true);
      document.addEventListener("keydown", closeOnEscape);
      return () => {
        document.removeEventListener("pointerdown", closeOutside, true);
        document.removeEventListener("keydown", closeOnEscape);
      };
    }, [anchorRef, open, onClose]);

    const content = (
      <Card
        variant="laser"
        tilt={false}
        ref={mergeRefs<HTMLElement>(ref, popoverRef)}
        className={`ui-popover ${className}`.trim()}
        data-open={open || undefined}
        sx={{ containerType: "normal" }}
        style={{
          ...style,
          ...(anchorRef && {
            position: "fixed",
            top: position?.top ?? 0,
            left: position?.left ?? 0,
            visibility: position ? "visible" : "hidden"
          })
        }}
        {...props}
      >
        {children}
      </Card>
    );
    return portal && typeof document !== "undefined" ? createPortal(content, document.body) : content;
  }
);

Popover.displayName = "Popover";
export default Popover;
