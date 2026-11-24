import { useLayoutEffect, useRef } from 'react';
import { useHostWindow } from '../../shared/ui/hostWindow';
import type { EditorWord } from '../../application/editor/editorModel';
import { letterProgress, type LetterGeometry } from './karaokeLyrics';

interface MeasuredWord {
  element: HTMLElement;
  word: EditorWord;
  geometry?: LetterGeometry;
  fill?: number;
}

const glyphGeometry = (
  element: HTMLElement,
  text: string,
): LetterGeometry | undefined => {
  const node = element.firstChild;
  const box = element.getBoundingClientRect();
  if (!node || node.nodeType !== Node.TEXT_NODE || !box.width) return undefined;
  const range = element.ownerDocument.createRange();
  const geometry: [number, number][] = [];
  let offset = 0;
  for (const character of text) {
    range.setStart(node, offset);
    offset += character.length;
    range.setEnd(node, offset);
    const glyph = range.getBoundingClientRect();
    geometry.push([
      (glyph.left - box.left) / box.width,
      (glyph.right - box.left) / box.width,
    ]);
  }
  return geometry;
};

const paint = (
  words: readonly MeasuredWord[],
  position: number,
  progress: typeof letterProgress,
): void => {
  for (const measured of words) {
    const fill = progress(measured.word, position, measured.geometry) * 100;
    if (measured.fill === fill) continue;
    measured.element.style.setProperty('--ad-lyric-fill', `${fill}%`);
    measured.fill = fill;
  }
};

/** Fit complete lines before measuring their letter fills, only when layout or text changes. */
export const useLyricFill = (
  id: string,
  words: readonly EditorWord[],
  position: number,
  font: string,
  progress = letterProgress,
  nextWords?: readonly EditorWord[],
): void => {
  const host = useHostWindow();
  const measured = useRef<MeasuredWord[]>([]);
  const clock = useRef(position);
  clock.current = position;
  useLayoutEffect(() => {
    const observeLine = () => {
      const root = host.document.getElementById(id);
      const line = root?.querySelector<HTMLElement>(
        ':not([data-completed]) > .ad-lyrics-current:not(:empty)',
      );
      if (!root || !line) return;
      let width = 0;
      const measure = () => {
        width = root.clientWidth;
        if (!width) return;
        for (const row of root.querySelectorAll<HTMLElement>(
          '.ad-lyrics-current:not(:empty), .ad-lyrics-next:not(:empty)',
        )) {
          const minimum =
            root.dataset.layout !== 'credits' &&
            row.matches('.ad-lyrics-current')
              ? 24
              : 18;
          row.style.removeProperty('font-size');
          row.style.whiteSpace = 'nowrap';
          row.style.textAlign = 'left';
          const base = parseFloat(host.getComputedStyle(row).fontSize);
          const natural = row.scrollWidth;
          const fitted =
            natural > width ? (base * (width - 2)) / natural : base;
          const size = Math.max(Math.min(base, minimum), fitted);
          row.style.fontSize = `${size}px`;
          row.style.whiteSpace = fitted < size ? 'normal' : 'nowrap';
          row.style.removeProperty('text-align');
        }
        const elements = line.querySelectorAll<HTMLElement>('.ad-lyric-word');
        measured.current = words.flatMap((word, index) => {
          const element = elements[index];
          return element
            ? [{ element, word, geometry: glyphGeometry(element, word.text) }]
            : [];
        });
        paint(measured.current, clock.current, progress);
      };
      measure();
      const observer =
        typeof ResizeObserver === 'undefined'
          ? undefined
          : new ResizeObserver(() => {
              if (root.clientWidth !== width) measure();
            });
      observer?.observe(root);
      const fonts = line.ownerDocument.fonts;
      fonts?.addEventListener('loadingdone', measure);
      return () => {
        observer?.disconnect();
        fonts?.removeEventListener('loadingdone', measure);
        measured.current = [];
      };
    };
    let stop = observeLine();
    if (stop) return stop;
    // The screen's parent layout effect may still be moving it to this document.
    const frame = host.requestAnimationFrame(() => {
      stop = observeLine();
    });
    return () => {
      host.cancelAnimationFrame(frame);
      stop?.();
    };
  }, [id, host, words, nextWords, font, progress]);
  // A new line or measurement resets the painted values; only changing fills need a DOM write.
  useLayoutEffect(() => paint(measured.current, position, progress));
};
