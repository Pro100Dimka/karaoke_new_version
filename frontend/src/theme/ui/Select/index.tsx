import { Check, ChevronDown } from "lucide-react";
import { Fragment, forwardRef, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useText } from "../../../i18n/useText";
import Button from "../Button";
import InputBase from "../InputBase";
import OutlinedInput from "../OutlinedInput";
import Popover from "../Popover";
import FieldMessage from "../_internal/FieldMessage";
import FloatingLabel from "../_internal/FloatingLabel";
import cx from "../_internal/cx";
import mergeRefs from "../_internal/mergeRefs";
import { optionItem } from "../_internal/option";
import mergeSx from "../_internal/sx";
import type { ControlSize, SelectOption, StyleVars } from "../_internal/types";
import useControllable from "../_internal/useControllable";
import useFieldIds from "../_internal/useFieldIds";
import { selectPosition, type SelectPlacement } from "./position";
import "./select.css";

const OPTION_SELECTOR = ".ui-select-option:not(:disabled)";

export interface SelectProps<T extends string | number = string> {
  id?: string;
  label?: string;
  hint?: string;
  tooltip?: string;
  error?: string;
  required?: boolean;
  disabled?: boolean;
  size?: ControlSize;
  options?: readonly (SelectOption<T> | T)[];
  value?: T;
  defaultValue?: T;
  onChange?: (value: T) => void;
  placeholder?: string;
  startIcon?: ReactNode;
  endIcon?: ReactNode;
  className?: string;
  fieldClassName?: string;
  sx?: StyleVars;
  fieldSx?: StyleVars;
  style?: StyleVars;
  fieldStyle?: StyleVars;
  fullWidth?: boolean;
  "aria-label"?: string;
}

function SelectInner<T extends string | number>(
  {
    id,
    label,
    hint,
    tooltip,
    error,
    required = false,
    disabled = false,
    size = "md",
    options = [],
    value,
    defaultValue,
    onChange,
    placeholder,
    startIcon,
    endIcon,
    className = "",
    fieldClassName = "",
    sx,
    fieldSx,
    style,
    fullWidth,
    fieldStyle,
    ...props
  }: SelectProps<T>,
  ref: React.Ref<HTMLElement>
) {
  const t = useText();
  const { controlId, hintId, errorId, describedBy } = useFieldIds("ui-select", id, hint, error);
  const triggerRef = useRef<HTMLElement | null>(null);
  const popoverRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<SelectPlacement | null>(null);
  const [current, setCurrent] = useControllable<T | undefined>(value, defaultValue, next => next !== undefined && onChange?.(next));

  const normalized = options.map(option => optionItem(option as SelectOption | string | number));
  const selected = normalized.find(item => String(item.value) === String(current));
  const listboxId = `${controlId}-listbox`;
  const emptyLabel = placeholder ?? t("selectPlaceholder");

  const updatePosition = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const next = selectPosition(rect, {
      width: document.documentElement.clientWidth,
      height: window.innerHeight,
      menuHeight: popoverRef.current?.scrollHeight ?? 0
    });
    setPosition(previous => (previous && (Object.keys(next) as (keyof SelectPlacement)[]).every(key => previous[key] === next[key]) ? previous : next));
  };

  const close = () => setOpen(false);
  const optionButtons = (): HTMLElement[] => [...(popoverRef.current?.querySelectorAll<HTMLElement>(OPTION_SELECTOR) ?? [])];
  const focusOption = (index: number) => optionButtons()[index]?.focus();

  const choose = (item: SelectOption) => {
    if (item.disabled) return;
    setCurrent(item.value as T);
    close();
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  useLayoutEffect(() => {
    if (!open) return undefined;
    updatePosition();
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && (triggerRef.current?.contains(event.target) || popoverRef.current?.contains(event.target))) return;
      close();
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updatePosition);
    if (triggerRef.current) observer?.observe(triggerRef.current);
    if (popoverRef.current) observer?.observe(popoverRef.current);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      observer?.disconnect();
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      const enabled = optionButtons();
      const index = enabled.findIndex(button => button.dataset.value === String(current));
      enabled[Math.max(0, index)]?.focus();
    });
  }, [open, current]);

  const onTriggerKey = (event: KeyboardEvent) => {
    if (disabled) return;
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      if (!open) {
        updatePosition();
        setOpen(true);
      }
    } else if (event.key === "Escape") close();
  };

  const onListKey = (event: KeyboardEvent) => {
    const buttons = optionButtons();
    const index = Math.max(0, buttons.indexOf(document.activeElement as HTMLElement));
    const targets: Record<string, number> = {
      ArrowDown: (index + 1) % buttons.length,
      ArrowUp: (index - 1 + buttons.length) % buttons.length,
      Home: 0,
      End: buttons.length - 1
    };
    const target = targets[event.key];
    if (target !== undefined) {
      event.preventDefault();
      focusOption(target);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
      triggerRef.current?.focus();
    } else if (event.key === "Tab") close();
  };

  const trigger = (
    <div className="ui-select-root">
      <OutlinedInput
        label={label}
        labelAccessory={Boolean(tooltip)}
        labelNode={<FloatingLabel id={controlId} label={label} required={required} tooltip={tooltip} />}
        required={required}
        disabled={disabled}
        error={!!error}
        size={size}
        className={cx("ui-select-field", className)}
        data-filled={Boolean(selected) || undefined}
        sx={sx}
        style={{ ...style, ...(fullWidth && { width: "100%" }) }}
      >
        <InputBase
          component={Button}
          ref={mergeRefs<HTMLElement>(triggerRef, ref)}
          id={controlId}
          type="button"
          unstyled
          size={size}
          className="ui-select-trigger ui-text-field-input"
          data-open={open || undefined}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-describedby={describedBy}
          onClick={() => {
            if (disabled) return;
            if (!open) updatePosition();
            setOpen(value => !value);
          }}
          onKeyDown={onTriggerKey}
          {...props}
        >
          {startIcon && (
            <span className="ui-select-start-icon" aria-hidden="true">
              {startIcon}
            </span>
          )}
          <span className="ui-select-value" data-placeholder={!selected || undefined}>
            {selected?.label ?? emptyLabel}
          </span>
          <span className="ui-select-actions" aria-hidden="true">
            {endIcon && <span className="ui-select-end-icon">{endIcon}</span>}
            <ChevronDown className="ui-select-chevron" size={16} />
          </span>
        </InputBase>
      </OutlinedInput>

      {open &&
        position &&
        createPortal(
          <Popover
            ref={popoverRef}
            open
            portal={false}
            id={listboxId}
            role="listbox"
            className="ui-select-popover ui-control"
            data-size={size}
            style={{
              position: "fixed",
              top: position.top,
              left: position.left,
              width: position.width,
              maxHeight: `min(24rem, ${position.maxHeight}px)`,
              transform: position.above ? "translateY(-100%)" : undefined
            }}
            onKeyDown={onListKey}
          >
            <div className="ui-select-options">
              {normalized.map((item, index) => {
                const active = String(item.value) === String(current);
                const showGroup = item.group && item.group !== normalized[index - 1]?.group;
                return (
                  <Fragment key={item.value}>
                    {showGroup && (
                      <div className="ui-select-group" role="presentation">
                        {item.group}
                      </div>
                    )}
                    <Button
                      unstyled
                      data-size={size}
                      role="option"
                      aria-selected={active}
                      disabled={item.disabled}
                      data-value={String(item.value)}
                      data-selected={active || undefined}
                      className="ui-select-option ui-control"
                      onClick={() => choose(item)}
                    >
                      <span className="ui-select-option-mark">{active && <Check />}</span>
                      {item.icon && (
                        <span className="ui-select-option-icon" aria-hidden="true">
                          {item.icon}
                        </span>
                      )}
                      <span className="ui-select-option-content">
                        <span className="ui-select-option-label">{item.label}</span>
                        {item.description && <span className="ui-select-option-description">{item.description}</span>}
                      </span>
                    </Button>
                  </Fragment>
                );
              })}
            </div>
          </Popover>,
          document.body
        )}
    </div>
  );

  if (!label && !hint && !error) return trigger;
  return (
    <div
      className={cx("ui-field", fieldClassName)}
      data-disabled={disabled || undefined}
      data-error={!!error || undefined}
      style={mergeSx(fieldSx, fieldStyle)}
    >
      {trigger}
      <FieldMessage errorId={errorId} hintId={hintId} error={error} hint={hint} />
    </div>
  );
}

const Select = forwardRef(SelectInner) as <T extends string | number = string>(
  props: SelectProps<T> & { ref?: React.Ref<HTMLElement> }
) => ReturnType<typeof SelectInner>;

export default Select;
