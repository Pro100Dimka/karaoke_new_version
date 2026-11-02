import { useLayoutEffect, useRef } from 'react';
import type { EditorWord } from '../../application/editor/editorModel';
import { letterProgress, type LetterGeometry } from './karaokeLyrics';

interface MeasuredWord {
  element: HTMLElement;
  word: EditorWord;
  geometry?: LetterGeometry;
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
  for (const { element, word, geometry } of words)
    element.style.setProperty(
      '--ad-lyric-fill',
      `${progress(word, position, geometry) * 100}%`,
    );
};

/** The UI kit fills physical width and rounds to whole percent. Measure only on layout changes. */
export const useLyricFill = (
  id: string,
  words: readonly EditorWord[],
  position: number,
  font: string,
  progress = letterProgress,
): void => {
  const measured = useRef<MeasuredWord[]>([]);
  const clock = useRef(position);
  clock.current = position;
  useLayoutEffect(() => {
    const root = document.getElementById(id);
    const line = root?.querySelector<HTMLElement>('.ad-lyrics-current');
    if (!line) return;
    const measure = () => {
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
        : new ResizeObserver(measure);
    observer?.observe(line);
    const fonts = line.ownerDocument.fonts;
    fonts?.addEventListener('loadingdone', measure);
    return () => {
      observer?.disconnect();
      fonts?.removeEventListener('loadingdone', measure);
      measured.current = [];
    };
  }, [id, words, font, progress]);
  // React may reapply the kit's rounded inline style on any render; restore the exact saved position.
  useLayoutEffect(() => paint(measured.current, position, progress));
};
