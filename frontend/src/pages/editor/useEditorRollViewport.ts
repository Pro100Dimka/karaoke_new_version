import { useCallback, useLayoutEffect, useState, type RefObject } from 'react';

const fallbackWidth = 1024;
export const editorPixelsPerSecond = (
  world: HTMLElement | null,
  length: number,
  zoom: number,
) =>
  world?.offsetWidth
    ? world.offsetWidth / length
    : 4 *
      zoom *
      (parseFloat(getComputedStyle(window.document.documentElement).fontSize) ||
        16);

export const useEditorRollViewport = (
  scroll: RefObject<HTMLElement | null>,
  world: RefObject<HTMLElement | null>,
  length: number,
  zoom: number,
) => {
  const [range, setRange] = useState(() => ({
    start: 0,
    end: Math.min(length, (fallbackWidth * 2) / (64 * zoom)),
  }));
  const measure = useCallback(() => {
    const box = scroll.current;
    if (!box) return;
    const width = box.clientWidth || fallbackWidth;
    const pixels = editorPixelsPerSecond(world.current, length, zoom);
    // One viewport of overscan covers the sticky keys and ordinary scroll/follow movement.
    const start = Math.max(0, Math.floor((box.scrollLeft - width) / pixels));
    const end = Math.min(
      Math.ceil(length),
      Math.ceil((box.scrollLeft + width * 2) / pixels),
    );
    setRange((previous) =>
      previous.start === start && previous.end === end
        ? previous
        : { start, end },
    );
  }, [scroll, world, length, zoom]);
  useLayoutEffect(() => {
    const box = scroll.current;
    const area = world.current;
    if (!box || !area) return;
    measure();
    box.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measure);
    observer?.observe(box);
    observer?.observe(area);
    return () => {
      box.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [scroll, world, measure]);
  return { ...range, measure };
};
