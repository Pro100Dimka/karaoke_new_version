import { act, render } from '@testing-library/react';
import { useId } from 'react';
import { KaraokeLyrics } from '@neo-ui-kit/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  EditorDocument,
  EditorWord,
} from '../../application/editor/editorModel';
import { QueryProvider } from '../../test/QueryProvider';
import { KaraokeStage } from './KaraokeStage';
import { letterProgress, type LetterGeometry } from './karaokeLyrics';
import { useLyricFill } from './useLyricFill';

vi.mock('./useSmoothPosition', () => ({
  useSmoothPosition: (position: number) => position,
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const stage = (word: EditorWord, position: number) => {
  const document: EditorDocument = {
    revision: 1,
    words: [word],
    notes: [],
    lyrics: word.text,
  };
  return (
    <QueryProvider application>
      <KaraokeStage
        songTitle="Measured letters"
        position={position}
        playing={false}
        rate={1}
        document={document}
        layers={{ showLyrics: true, showNotes: false }}
        vocalRange="auto"
      />
    </QueryProvider>
  );
};

// Measured in the shipped Electron and Melodix font, including the component's trailing space.
const floorWord: EditorWord = {
  id: 'floor',
  text: 'этаж,',
  start: 10.7,
  end: 12.36,
  letters: [10.7, 10.9, 11, 11.34, 11.38].map((time) => (time - 10.7) / 1.66),
};
const glyphEdges = [
  0, 44.84375, 91.40625, 142.96875, 203.734375, 216.21875,
] as const;
const wordWidth = 235.640625;

const measure = (edges: readonly number[] = glyphEdges, width = wordWidth) => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      return new DOMRect(
        0,
        0,
        this.classList.contains('ad-lyric-word') ? width : 1000,
        78,
      );
    },
  );
  const createRange = document.createRange.bind(document);
  return vi.spyOn(document, 'createRange').mockImplementation(() => {
    const range = createRange();
    Object.defineProperty(range, 'getBoundingClientRect', {
      value: () => {
        const left = edges[range.startOffset] ?? width;
        const right = edges[range.endOffset] ?? width;
        return new DOMRect(left, 0, right - left, 78);
      },
    });
    return range;
  });
};

const fill = (container: HTMLElement) => {
  const word = container.querySelector<HTMLElement>(
    '.ad-lyrics-current .ad-lyric-word',
  );
  if (!word) throw new Error('Expected a rendered lyric word');
  return parseFloat(word.style.getPropertyValue('--ad-lyric-fill'));
};

const RenderedLyrics = ({
  words,
  position,
  font = 'melodix',
}: {
  words: readonly EditorWord[];
  position: number;
  font?: string;
}) => {
  const id = useId();
  useLyricFill(id, words, position, font);
  return (
    <KaraokeLyrics
      id={id}
      current={words.map((word) => ({
        id: word.id,
        text: word.text,
        progress: letterProgress(word, position),
      }))}
      next={[]}
      currentKey={words[0]?.id}
    />
  );
};

describe('rendered lyric letter boundaries', () => {
  it('updates the measured fill without first writing a rounded approximation', () => {
    measure();
    const view = render(stage(floorWord, 11.34));
    const writes = vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty');
    view.rerender(stage(floorWord, 11.5));
    const expected = `${fill(view.container)}%`;
    const fills = writes.mock.calls
      .filter(([name]) => name === '--ad-lyric-fill')
      .map(([, value]) => value);
    expect(fills.length).toBeGreaterThan(0);
    expect(fills.every((value) => value === expected)).toBe(true);
  });

  it('fills a syllable using its measured glyph edges', () => {
    measure();
    const view = render(stage(floorWord, 11.34));
    expect((fill(view.container) / 100) * wordWidth).toBeCloseTo(
      glyphEdges[1] + (glyphEdges[4] - glyphEdges[1]) * (11.34 - 10.9) / (12.36 - 10.9),
      3,
    );
  });

  it("uses the saved times continuously without the component's whole-percent quantization", () => {
    measure();
    const view = render(stage(floorWord, 11.3401));
    const earlier = fill(view.container);
    view.rerender(stage(floorWord, 11.3402));
    expect(fill(view.container)).toBeGreaterThan(earlier);
  });

  it.each(['отдать', 'любовь', 'пам’ять'])(
    'does not give a silent sign in %s its own sounding interval',
    (text) => {
      const letters = [...text].map((_, i) => i / text.length);
      const word: EditorWord = {
        id: 'silent',
        text,
        start: 0,
        end: 2,
        letters,
      };
      const altered = { ...word, letters: [...letters.slice(0, -1), 0.99] };
      for (const time of [0.2, 1, 1.5, 1.8, 1.99])
        expect(letterProgress(word, time)).toBe(letterProgress(altered, time));
    },
  );

  it.each(['ъ', 'Ь', "'", '’', 'ʼ', ' '])(
    'does not assign %s an independent interval inside a word',
    (sign) => {
      const word: EditorWord = {
        id: 'sign',
        text: `а${sign}я`,
        start: 0,
        end: 1,
        letters: [0, 0.1, 0.6],
      };
      const laterMark = { ...word, letters: [0, 0.5, 0.6] };
      for (const time of [0.05, 0.2, 0.55, 0.7])
        expect(letterProgress(word, time)).toBe(
          letterProgress(laterMark, time),
        );
    },
  );

  it.each([
    {
      text: 'мо\u0301ре',
      letters: [0, 0.1, 0.7, 0.7, 0.8],
      expected: 0.44,
      geometry: [
        [0, 0.3],
        [0.3, 0.58],
        [0.3, 0.58],
        [0.58, 0.8],
        [0.8, 1],
      ],
    },
    {
      text: 'е\u0308лка',
      letters: [0, 0.6, 0.6, 0.7, 0.8],
      expected: (0.2 * 0.4) / 0.6,
      geometry: [
        [0, 0.2],
        [0, 0.2],
        [0.2, 0.46],
        [0.46, 0.7],
        [0.7, 1],
      ],
    },
  ] satisfies {
    text: string;
    letters: number[];
    expected: number;
    geometry: LetterGeometry;
  }[])(
    'keeps a combining mark with its vowel in $text',
    ({ text, letters, expected, geometry }) => {
      const word: EditorWord = {
        id: 'accent',
        text,
        letters,
        start: 0,
        end: 1,
      };
      expect(letterProgress(word, 0.4, geometry)).toBeCloseTo(expected);
    },
  );

  it('keeps the final sounded glyph active to word.end without allocating time to punctuation or trailing space', () => {
    measure();
    const view = render(
      <RenderedLyrics words={[floorWord]} position={12.359} />,
    );
    expect((fill(view.container) / 100) * wordWidth).toBeLessThan(
      glyphEdges[4],
    );
    view.rerender(<RenderedLyrics words={[floorWord]} position={12.36} />);
    expect(fill(view.container)).toBe(100);
    view.rerender(<RenderedLyrics words={[floorWord]} position={10.5} />);
    expect(fill(view.container)).toBe(0);
  });

  it('maps Ukrainian glyph widths while preserving a measured held vowel and a genuinely fast word', () => {
    measure([0, 60, 75, 140], 160);
    const word: EditorWord = {
      id: 'uk',
      text: 'дім',
      start: 1,
      end: 2,
      letters: [0, 0.03, 0.95],
    };
    const view = render(<RenderedLyrics words={[word]} position={1.5} />);
    expect(fill(view.container) * 1.6).toBeCloseTo(60 + (15 * 0.47) / 0.92);
    const fast: EditorWord = {
      id: 'fast',
      text: 'і',
      start: 2,
      end: 2.03,
      letters: [0],
    };
    view.rerender(<RenderedLyrics words={[fast]} position={2.015} />);
    expect(fill(view.container) * 1.6).toBeCloseTo(30);
    view.rerender(<RenderedLyrics words={[fast]} position={2.03} />);
    expect(fill(view.container)).toBe(100);
  });

  it('retains the approximate timing fallback while mapping its letters to actual widths', () => {
    measure([0, 60, 75, 140], 160);
    const word: EditorWord = { id: 'legacy', text: 'дім', start: 1, end: 2 };
    const view = render(<RenderedLyrics words={[word]} position={1.07} />);
    expect(fill(view.container) * 1.6).toBeCloseTo(60);
    view.rerender(<RenderedLyrics words={[word]} position={2} />);
    expect(fill(view.container)).toBe(100);
  });

  it('reuses geometry across playback and backward seeks, then remeasures changed lines and fonts', () => {
    const ranges = measure();
    const words = [floorWord];
    const view = render(<RenderedLyrics words={words} position={11.34} />);
    const count = ranges.mock.calls.length;
    for (const position of [11.5, 12.1, 10.8, 11.34])
      view.rerender(<RenderedLyrics words={words} position={position} />);
    expect(ranges).toHaveBeenCalledTimes(count);
    expect((fill(view.container) / 100) * wordWidth).toBeCloseTo(glyphEdges[3]);
    view.rerender(
      <RenderedLyrics words={words} position={11.34} font="serif" />,
    );
    expect(ranges).toHaveBeenCalledTimes(count * 2);
    view.rerender(
      <RenderedLyrics
        words={[{ ...floorWord, id: 'next-line' }]}
        position={11.34}
        font="serif"
      />,
    );
    expect(ranges).toHaveBeenCalledTimes(count * 3);
  });

  it('invalidates widths on resize and font completion and removes observers on unmount', () => {
    const ranges = measure();
    const fonts = new EventTarget();
    const descriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: fonts,
    });
    const observers: Observer[] = [];
    class Observer implements ResizeObserver {
      constructor(readonly callback: ResizeObserverCallback) {
        observers.push(this);
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal('ResizeObserver', Observer);
    try {
      const words = [floorWord];
      const view = render(<RenderedLyrics words={words} position={11.34} />);
      const count = ranges.mock.calls.length;
      const observer = observers[0];
      if (!observer) throw new Error('Expected a lyric layout observer');
      act(() => observer.callback([], observer));
      expect(ranges).toHaveBeenCalledTimes(count * 2);
      act(() => fonts.dispatchEvent(new Event('loadingdone')));
      expect(ranges).toHaveBeenCalledTimes(count * 3);
      view.unmount();
      expect(observer.disconnect).toHaveBeenCalledOnce();
      act(() => fonts.dispatchEvent(new Event('loadingdone')));
      expect(ranges).toHaveBeenCalledTimes(count * 3);
    } finally {
      if (descriptor) Object.defineProperty(document, 'fonts', descriptor);
      else Reflect.deleteProperty(document, 'fonts');
    }
  });
});
