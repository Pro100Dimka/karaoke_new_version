import { useId, type KeyboardEvent, type ReactNode } from "react";
import mergeSx from "../_internal/sx";
import type { StyleVars } from "../_internal/types";
import useControllable from "../_internal/useControllable";
import "./tabs.css";

export interface TabItem<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  content?: ReactNode;
}

export interface TabsProps<T extends string> {
  items: readonly TabItem<T>[];
  value?: T;
  defaultValue?: T;
  onChange?: (value: T) => void;
  className?: string;
  sx?: StyleVars;
  style?: StyleVars;
}

export default function Tabs<T extends string>({ items, value, defaultValue, onChange, className = "", sx, style }: TabsProps<T>) {
  const id = useId().replace(/:/g, "");
  const first = items[0]?.value;
  const [current, setCurrent] = useControllable<T | undefined>(value, defaultValue ?? first, onChange as (next: T | undefined) => void);
  const activeItem = items.find(item => item.value === current);
  const currentIndex = Math.max(0, items.findIndex(item => item.value === current));

  const move = (index: number, list: HTMLElement) => {
    const item = items[index];
    if (item && !item.disabled) {
      setCurrent(item.value);
      list.querySelectorAll<HTMLElement>('[role="tab"]')[index]?.focus();
    }
  };

  const edge = (from: number, direction: 1 | -1): number => {
    for (let step = 1; step <= items.length; step += 1) {
      const index = (from + direction * step + items.length) % items.length;
      if (!items[index]?.disabled) return index;
    }
    return from;
  };

  const handleKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!items.length) return;
    const list = event.currentTarget;
    const targets: Record<string, number> = {
      ArrowRight: edge(currentIndex, 1),
      ArrowLeft: edge(currentIndex, -1),
      Home: items.findIndex(item => !item.disabled),
      End: items.map(item => !item.disabled).lastIndexOf(true)
    };
    const target = targets[event.key];
    if (target === undefined) return;
    event.preventDefault();
    move(target, list);
  };

  return (
    <div className={`ui-tabs ${className}`.trim()} style={mergeSx(sx, style)}>
      <div className="ui-tabs-list" role="tablist" onKeyDown={handleKey}>
        {items.map(item => {
          const active = item.value === current;
          return (
            <button
              key={item.value}
              id={`${id}-tab-${item.value}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`${id}-panel-${item.value}`}
              tabIndex={active ? 0 : -1}
              disabled={item.disabled}
              className="ui-tab"
              data-active={active || undefined}
              onClick={() => setCurrent(item.value)}
            >
              {item.icon && (
                <span className="ui-tab-icon" aria-hidden="true">
                  {item.icon}
                </span>
              )}
              <span className="ui-tab-label">{item.label}</span>
            </button>
          );
        })}
      </div>
      {activeItem?.content !== undefined && (
        <div id={`${id}-panel-${activeItem.value}`} className="ui-tab-panel" role="tabpanel" aria-labelledby={`${id}-tab-${activeItem.value}`}>
          {activeItem.content}
        </div>
      )}
    </div>
  );
}
