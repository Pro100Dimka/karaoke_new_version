import { useVirtualizer } from "@tanstack/react-virtual";
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

interface VirtualGridProps<T> {
  items: readonly T[];
  itemKey(item: T): string;
  itemHeight: number;
  minColumnWidth: number;
  gap: number;
  scrollParent: RefObject<HTMLElement | null>;
  label: string;
  renderItem(item: T): ReactNode;
}

const overscanRows = 2;

/** Row virtualization is delegated to TanStack Virtual; only the responsive column count is computed here. */
export const VirtualGrid = <T,>({
  items,
  itemKey,
  itemHeight,
  minColumnWidth,
  gap,
  scrollParent,
  label,
  renderItem
}: VirtualGridProps<T>) => {
  const rootRef = useRef<HTMLUListElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(() => setWidth(root.clientWidth));
    observer.observe(root);
    setWidth(root.clientWidth);
    return () => observer.disconnect();
  }, []);

  const columns = Math.max(1, Math.floor((width + gap) / (minColumnWidth + gap)));
  const rowCount = Math.ceil(items.length / columns);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollParent.current,
    estimateSize: () => itemHeight + gap,
    overscan: overscanRows,
    scrollMargin: rootRef.current?.offsetTop ?? 0
  });

  return (
    <ul
      ref={rootRef}
      className="songGrid"
      aria-label={label}
      style={{ height: virtualizer.getTotalSize(), position: "relative" }}
    >
      {virtualizer.getVirtualItems().map(row => (
        <li
          key={row.key}
          className="songGridRow"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: itemHeight,
            transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)`,
            display: "grid",
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            gap
          }}
        >
          {items.slice(row.index * columns, (row.index + 1) * columns).map(item => (
            <div key={itemKey(item)} className="songGridItem">
              {renderItem(item)}
            </div>
          ))}
        </li>
      ))}
    </ul>
  );
};
