import { Grid } from "@neo-ui-kit/react";
import {
  elementScroll,
  observeElementOffset,
  observeElementRect,
  Virtualizer,
  type VirtualItem,
} from "@tanstack/react-virtual";
import { action, observableRef } from "mobx";
import { observer, useLocalObservable } from "mobx-react-lite";
import type { ReactNode, RefObject } from "react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SongDto } from "../../../../contracts/models";

interface SongGridProps {
  items: readonly SongDto[];
  scrollParent: RefObject<HTMLElement | null>;
  itemKey(song: SongDto): string;
  renderItem(song: SongDto): ReactNode;
  label: string;
  hasNextPage?: boolean;
  loading?: boolean;
  loadMore?(): unknown;
}

const columns = { base: 1, md: 2, lg: 4 };

export const VirtualGrid = observer(
  ({
    items: songs,
    scrollParent: scrollRef,
    itemKey,
    renderItem,
    label,
    hasNextPage = false,
    loading = false,
    loadMore,
  }: SongGridProps) => {
    const gridRef = useRef<HTMLDivElement>(null);
    const layout = useLocalObservable(
      () => ({
        columns: 1,
        margin: 0,
        width: 0,
        rows: new Array<VirtualItem>(),
        height: 0,
      }),
      { rows: observableRef },
    );
    const count = Math.ceil(songs.length / layout.columns);
    const options = {
      count,
      estimateSize: () => Math.max(140, layout.width / layout.columns / 3),
      scrollMargin: layout.margin,
      overscan: 3,
      gap: 16,
      useScrollendEvent: true,
      observeElementOffset,
      observeElementRect,
      scrollToFn: elementScroll,
    };
    const [virtualizer] = useState(
      () =>
        new Virtualizer<HTMLElement, HTMLDivElement>({
          ...options,
          getScrollElement: () => null,
          onChange: action((instance) => {
            layout.rows = instance.getVirtualItems();
            layout.height = instance.getTotalSize();
          }),
        }),
    );
    const { rows, height } = layout;
    const hasRows = rows.length > 0;
    useLayoutEffect(() => virtualizer._didMount(), [virtualizer]);
    useLayoutEffect(() => {
      virtualizer.setOptions({
        ...virtualizer.options,
        ...options,
        getScrollElement: () => scrollRef.current,
      });
      virtualizer._willUpdate();
      virtualizer.options.onChange?.(virtualizer, false);
    });
    useLayoutEffect(() => {
      const grid = gridRef.current;
      const scroll = scrollRef.current;
      if (!grid || !scroll) return;
      const measure = action(() => {
        const probe = grid.firstElementChild?.firstElementChild;
        if (!probe) return;
        Object.assign(layout, {
          columns:
            getComputedStyle(probe).gridTemplateColumns.split(" ").length,
          margin:
            grid.getBoundingClientRect().top -
            scroll.getBoundingClientRect().top +
            scroll.scrollTop,
          width: grid.clientWidth,
        });
      });
      const observer = new ResizeObserver(measure);
      [scroll, grid, grid.parentElement].forEach(
        (element) => element && observer.observe(element),
      );
      measure();
      return () => observer.disconnect();
    }, [scrollRef, layout, hasRows]);
    useLayoutEffect(() => {
      virtualizer.measure();
    }, [layout.columns, layout.width, virtualizer]);

    const last = rows.at(-1)?.index ?? -1;
    useEffect(() => {
      if (hasNextPage && !loading && last >= count - 4) void loadMore?.();
    }, [last, count, hasNextPage, loading, loadMore]);
    return (
      <div
        ref={gridRef}
        role="list"
        aria-label={label}
        style={{
          position: "relative",
          height,
          minWidth: 0,
        }}
      >
        {rows.map((row) => (
          <div
            key={row.key}
            data-index={row.index}
            ref={virtualizer.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${row.start - layout.margin}px)`,
            }}
          >
            <Grid columns={columns} gap={3}>
              {songs
                .slice(
                  row.index * layout.columns,
                  (row.index + 1) * layout.columns,
                )
                .map((song) => (
                  <Fragment key={itemKey(song)}>{renderItem(song)}</Fragment>
                ))}
            </Grid>
          </div>
        ))}
      </div>
    );
  },
);

export default VirtualGrid;
