import { cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./tooltip.css";

type Placement = "top" | "bottom" | "left" | "right";
const GAP = 3;

const place = (rect: DOMRect, placement: Placement): { top: number; left: number } => {
  if (placement === "bottom") return { top: rect.bottom + GAP, left: rect.left + rect.width / 2 };
  if (placement === "left") return { top: rect.top + rect.height / 2, left: rect.left - GAP };
  if (placement === "right") return { top: rect.top + rect.height / 2, left: rect.right + GAP };
  return { top: rect.top - GAP, left: rect.left + rect.width / 2 };
};

interface TriggerProps {
  ref?: React.Ref<HTMLElement>;
  onMouseEnter?: (event: React.MouseEvent) => void;
  onMouseLeave?: (event: React.MouseEvent) => void;
  onFocus?: (event: React.FocusEvent) => void;
  onBlur?: (event: React.FocusEvent) => void;
}

export default function Tooltip({
  title,
  children,
  placement = "top",
  disabled = false
}: {
  title?: ReactNode;
  children: ReactNode;
  placement?: Placement;
  disabled?: boolean;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const updatePosition = () => {
    const element = triggerRef.current;
    if (element) setPosition(place(element.getBoundingClientRect(), placement));
  };

  const show = () => {
    if (disabled || !title) return;
    updatePosition();
    setOpen(true);
  };
  const hide = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const update = () => {
      const element = triggerRef.current;
      if (element) setPosition(place(element.getBoundingClientRect(), placement));
    };
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, placement]);

  if (!title || disabled) return <>{children}</>;

  const trigger = isValidElement<TriggerProps>(children) ? (
    cloneElement(children as ReactElement<TriggerProps & { "aria-describedby"?: string }>, {
      ref: triggerRef,
      "aria-describedby": open ? id : undefined,
      onMouseEnter: event => {
        children.props.onMouseEnter?.(event);
        show();
      },
      onMouseLeave: event => {
        children.props.onMouseLeave?.(event);
        hide();
      },
      onFocus: event => {
        children.props.onFocus?.(event);
        show();
      },
      onBlur: event => {
        children.props.onBlur?.(event);
        hide();
      }
    })
  ) : (
    <span
      ref={triggerRef}
      className="ui-tooltip-trigger"
      aria-describedby={open ? id : undefined}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
    </span>
  );

  return (
    <>
      {trigger}
      {open &&
        position &&
        createPortal(
          <div id={id} role="tooltip" className="ui-tooltip" data-placement={placement} style={{ top: position.top, left: position.left }}>
            {title}
          </div>,
          document.body
        )}
    </>
  );
}
