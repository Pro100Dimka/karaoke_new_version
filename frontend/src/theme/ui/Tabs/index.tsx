import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import mergeSx from "../_internal/sx";
import type { StyleVars } from "../_internal/types";
import useControllable from "../_internal/useControllable";
import "./tabs.css";

type TabEdge = "start" | "end" | "both" | undefined;

const TabShape = ({ edge }: { edge: TabEdge }) => {
  const ref = useRef<SVGSVGElement | null>(null);
  const fillId = `tab-active-fill-${useId().replaceAll(":", "")}`;
  useEffect(() => {
    const shape = ref.current;
    const button = shape?.parentElement;
    if (!shape || !button) return;
    const paths = [...shape.querySelectorAll<SVGPathElement>(".ui-tab-shape__contour")];
    const floor = shape.querySelector<SVGPathElement>(".ui-tab-shape__floor");
    const sync = () => {
      const width = button.offsetWidth;
      const height = button.offsetHeight;
      if (!width || !height) return;
      shape.setAttribute("viewBox", `0 0 ${width} ${height}`);
      const reachesStart = edge === "start" || edge === "both";
      const reachesEnd = edge === "end" || edge === "both";
      const start = reachesStart
        ? `M0 ${height - 3}V2H`
        : `M5 ${height - 3}Q10 ${height - 5} 12 ${height - 15}L22 14Q25 2 38 2H`;
      const end = reachesEnd
        ? `${width}V${height - 3}H`
        : `${width - 38}Q${width - 25} 2 ${width - 22} 14L${width - 12} ${height - 15}Q${width - 10} ${height - 5} ${width - 5} ${height - 3}H`;
      const contour = `${start}${end}${width / 2 + 6}L${width / 2} ${height + 1}L${width / 2 - 6} ${height - 3}Z`;
      paths.forEach(path => path.setAttribute("d", contour));
      floor?.setAttribute("d", `M${reachesStart ? 0 : 6} ${height - 3}H${width / 2 - 7}L${width / 2} ${height + 1}L${width / 2 + 7} ${height - 3}H${reachesEnd ? width : width - 6}`);
    };
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(sync);
    resize?.observe(button);
    sync();
    return () => resize?.disconnect();
  }, [edge]);
  return (
    <svg ref={ref} className="ui-tab-shape" fill="none" aria-hidden="true">
      <defs><linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
        <stop stopColor="var(--settings-tab-fill-top, #7d0926)" stopOpacity=".77" />
        <stop offset=".38" stopColor="var(--settings-tab-fill-mid, #370014)" stopOpacity=".86" />
        <stop offset=".76" stopColor="var(--settings-tab-fill-bottom, #130309)" stopOpacity=".94" />
        <stop offset="1" stopColor="var(--settings-tab-fill-edge, #9b082d)" stopOpacity=".94" />
      </linearGradient></defs>
      <path className="ui-tab-shape__contour ui-tab-shape__glow" />
      <path className="ui-tab-shape__contour ui-tab-shape__edge" fill={`url(#${fillId})`} />
      <path className="ui-tab-shape__contour ui-tab-shape__glint" pathLength="100" />
      <path className="ui-tab-shape__floor" />
    </svg>
  );
};

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
        {items.map((item, index) => {
          const active = item.value === current;
          const edge: TabEdge = index === 0
            ? (items.length === 1 ? "both" : "start")
            : (index === items.length - 1 ? "end" : undefined);
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
              data-edge={edge}
              onClick={() => setCurrent(item.value)}
            >
              <TabShape edge={edge} />
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
