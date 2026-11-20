import { autorun } from 'mobx';
import { useLayoutEffect, type RefObject } from 'react';
import type { EditorDocument } from '../../application/editor/editorModel';

/** Animate the editor clock without rebuilding every note, word and ruler tick. */
export const useEditorRollClock = (
  page: RefObject<HTMLElement | null>,
  document: EditorDocument | null,
  readPosition: () => number,
  duration: number,
  zoom: number,
  follow: boolean,
): void => {
  useLayoutEffect(() => {
    const root = page.current;
    if (!root || !document) return;
    const heads = root.querySelectorAll<HTMLElement>(
      '.ad-piano-roll-playhead, .ad-piano-roll-head-mark',
    );
    const bind = (
      items: readonly { start: number; end: number }[],
      selector: string,
      words = false,
    ) => {
      const elements = root.querySelectorAll<HTMLElement>(selector);
      return items.flatMap((item, index) => {
        const element = elements[index];
        return element
          ? [
              {
                element,
                start: item.start,
                end: item.end,
                now: element.hasAttribute('data-now'),
                sung: element.hasAttribute('data-sung'),
                words,
              },
            ]
          : [];
      });
    };
    const timed = [
      ...bind(document.notes, '.ad-piano-roll-note'),
      ...bind(document.words, '.ad-piano-roll-words > span', true),
    ];
    const scroll = root.querySelector<HTMLElement>('.ad-piano-roll-scroll');
    const world = root.querySelector<HTMLElement>('.ad-piano-roll-world');
    return autorun(() => {
      const position = readPosition();
      // Read follow geometry before changing styles, avoiding a write/read layout cycle.
      const x =
        follow && world
          ? (position / Math.max(duration, 1)) * world.offsetWidth
          : 0;
      const left = scroll?.scrollLeft ?? 0;
      const width = follow ? (scroll?.clientWidth ?? 0) : 0;
      for (const head of heads)
        head.style.left = `calc(var(--ad-pps) * ${position})`;
      for (const item of timed) {
        const now = position >= item.start && position <= item.end;
        if (item.now !== now) {
          item.element.toggleAttribute('data-now', now);
          item.now = now;
        }
        const sung = position > item.end;
        if (item.words && item.sung !== sung) {
          item.element.toggleAttribute('data-sung', sung);
          item.sung = sung;
        }
      }
      if (follow && scroll && (x < left || x > left + width * 0.8))
        scroll.scrollLeft = Math.max(0, x - width * 0.3);
    });
  }, [page, document, readPosition, duration, zoom, follow]);
};
