import { Grid } from '@neo-ui-kit/react';
import {
  elementScroll,
  measureElement,
  observeElementOffset,
  observeElementRect,
  Virtualizer,
  type VirtualItem,
} from '@tanstack/react-virtual';
import { action, observableRef } from 'mobx';
import { observer, useLocalObservable } from 'mobx-react-lite';
import type { ReactNode, RefObject } from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SongDto } from '../../../../contracts/models';

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
    // Keep Virtualizer configuration stable while only the surrounding modal changes.
    // A new options object would force a synchronous virtualizer update on every render.
    const options = useMemo(
      () => ({
        count,
        estimateSize: () => Math.max(140, layout.width / layout.columns / 3),
        scrollMargin: layout.margin,
        overscan: 3,
        gap: 16,
        useScrollendEvent: true,
        observeElementOffset,
        observeElementRect,
        scrollToFn: elementScroll,
      }),
      [count, layout.width, layout.columns, layout.margin],
    );
    const [virtualizer] = useState(
      () =>
        new Virtualizer<HTMLElement, HTMLDivElement>({
          ...options,
          getScrollElement: () => null,
          // Use observer measurements after layout, rather than forcing layout during each mount.
          measureElement: (element, entry, instance) => {
            const index = instance.indexFromElement(element);
            return entry
              ? measureElement(element, entry, instance)
              : (instance.itemSizeCache.get(
                  instance.options.getItemKey(index),
                ) ?? instance.options.estimateSize(index));
          },
          onChange: action((instance) => {
            layout.rows = instance.getVirtualItems();
            layout.height = instance.getTotalSize();
          }),
        }),
    );
    const { rows, height } = layout;
    const hasRows = rows.length > 0;
    useLayoutEffect(() => virtualizer._didMount(), [virtualizer]);
    // The parent's scroll ref is attached after this child's layout effects.
    useEffect(() => {
      virtualizer.setOptions({
        ...virtualizer.options,
        ...options,
        getScrollElement: () => scrollRef.current,
      });
      virtualizer._willUpdate();
      virtualizer.options.onChange?.(virtualizer, false);
    }, [virtualizer, options, scrollRef]);
    useLayoutEffect(() => {
      const grid = gridRef.current;
      const scroll = scrollRef.current;
      if (!grid || !scroll) return;
      const measure = action(() => {
        const probe = grid.firstElementChild?.firstElementChild;
        const card = probe?.firstElementChild;
        if (!probe || !card) return;
        const width = probe.getBoundingClientRect().width;
        const cardWidth = card.getBoundingClientRect().width;
        if (width <= 0 || cardWidth <= 0) return;
        const gap = parseFloat(getComputedStyle(probe).columnGap) || 0;
        Object.assign(layout, {
          columns: Math.max(1, Math.round((width + gap) / (cardWidth + gap))),
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
          position: 'relative',
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
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${row.start - layout.margin}px)`,
            }}
          >
            <Grid columns={12} gap={3}>
              {songs
                .slice(
                  row.index * layout.columns,
                  (row.index + 1) * layout.columns,
                )
                .map((song) => (
                  <Grid
                    key={itemKey(song)}
                    span={{ base: 'full', sm: 6, md: 4, lg: 3, xl: 3 }}
                  >
                    {renderItem(song)}
                  </Grid>
                ))}
            </Grid>
          </div>
        ))}
      </div>
    );
  },
);

export default VirtualGrid;
