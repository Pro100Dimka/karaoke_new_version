import { X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useText } from "../../../i18n/useText";
import Card, { type CardVariant } from "../Card";
import IconButton from "../IconButton";
import Primitive from "../_internal/Primitive";
import cx from "../_internal/cx";
import "./modal.css";
import ModalTitle, { type ModalTitleProps } from "./title";

const FOCUSABLE =
  "button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])";
const SIZES = { sm: "32rem", md: "42rem", lg: "52rem" } as const;
const dialogs: symbol[] = [];
let locks = 0;
let previousOverflow = "";

const lockBody = () => {
  if (!locks) {
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  locks += 1;
};

const unlockBody = () => {
  locks = Math.max(0, locks - 1);
  if (!locks) {
    document.body.style.overflow = previousOverflow;
    previousOverflow = "";
  }
};

export interface ModalProps {
  children?: ReactNode;
  isOpen: boolean;
  onClose?: () => void;
  ariaLabel?: string;
  closeAriaLabel?: string;
  closeIconSize?: number;
  portal?: boolean;
  tilt?: boolean;
  titleProps?: ModalTitleProps;
  cardVariant?: CardVariant;
  size?: keyof typeof SIZES;
  maxWidth?: string;
  backdropClassName?: string;
  modalClassName?: string;
  closeClassName?: string;
}

export default function Modal({
  children,
  isOpen,
  onClose,
  ariaLabel,
  closeAriaLabel,
  closeIconSize = 58,
  portal = false,
  tilt = true,
  titleProps,
  cardVariant = "neon",
  size = "md",
  maxWidth,
  backdropClassName,
  modalClassName,
  closeClassName
}: ModalProps) {
  const t = useText();
  const close = useRef(onClose);
  const dialog = useRef<HTMLElement | null>(null);
  const token = useRef(Symbol("modal"));
  const titleId = useId();

  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useLayoutEffect(() => {
    if (!isOpen) return undefined;
    const { current } = token;
    const previous = document.activeElement;
    dialogs.push(current);
    lockBody();
    const frame = requestAnimationFrame(() => {
      if (dialogs.at(-1) === current) (dialog.current?.querySelector<HTMLElement>(FOCUSABLE) ?? dialog.current)?.focus();
    });
    const keydown = (event: KeyboardEvent) => {
      if (dialogs.at(-1) !== current) return;
      if (event.key === "Escape") {
        if (event.target instanceof Element && event.target.closest('[role="listbox"]')) return;
        event.preventDefault();
        event.stopPropagation();
        close.current?.();
        return;
      }
      if (event.key !== "Tab") return;
      const items = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      const first = items[0];
      const last = items.at(-1);
      if (!first || (event.shiftKey && document.activeElement === first)) {
        event.preventDefault();
        (last ?? dialog.current)?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", keydown, true);
      const top = dialogs.at(-1) === current;
      dialogs.splice(dialogs.lastIndexOf(current), 1);
      unlockBody();
      if (top && previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const content = (
    <Primitive
      className={cx("ui-modal-backdrop", backdropClassName)}
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget && dialogs.at(-1) === token.current) close.current?.();
      }}
    >
      <Card
        ref={dialog}
        as="section"
        variant={cardVariant}
        tilt={tilt}
        className={cx("ui-modal-dialog", modalClassName)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        sx={{ "--ui-modal-size": SIZES[size], maxInlineSize: maxWidth ?? "calc(100vw - var(--space-8))" }}
        overlay={
          <IconButton
            icon={X}
            iconSize={closeIconSize}
            unstyled
            className={cx("ui-modal-close", closeClassName)}
            onClick={() => close.current?.()}
            label={closeAriaLabel ?? t("close")}
          />
        }
      >
        <Primitive as="span" id={titleId} className="ui-visually-hidden">
          {ariaLabel ?? titleProps?.title ?? t("dialog")}
        </Primitive>
        {titleProps && <ModalTitle {...titleProps} />}
        <Primitive className="ui-modal-body">{children}</Primitive>
        {titleProps?.actions && <Primitive className="ui-modal-actions">{titleProps.actions}</Primitive>}
      </Card>
    </Primitive>
  );
  return portal ? createPortal(content, document.body) : content;
}

export { default as ModalCarouselNavigation } from "./carousel-navigation";
export { default as ModalTitle } from "./title";
