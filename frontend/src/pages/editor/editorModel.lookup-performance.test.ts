import { expect, it, vi } from 'vitest';
import {
  moveNotes,
  resizeNote,
  type EditorDocument,
} from '../../application/editor/editorModel';

const largeDocument = (): EditorDocument => ({
  revision: 1,
  words: Array.from({ length: 2000 }, (_, index) => ({
    id: `w${index}`,
    text: 'voice',
    start: index * 4,
    end: index * 4 + 4,
  })),
  notes: Array.from({ length: 8000 }, (_, index) => ({
    id: `n${index}`,
    wordId: `w${Math.floor(index / 4)}`,
    pitch: 60,
    start: index + 0.2,
    end: index + 0.7,
  })),
});

it.each(['move', 'resize'] as const)(
  'does not rebuild unrelated word groups or rescan word IDs throughout a %s drag',
  (operation) => {
    const source = largeDocument();
    const selected = new Set(['n7200', 'n7201']);
    const preview = (step: number) =>
      operation === 'move'
        ? moveNotes(source, selected, step % 3, step / 100)
        : resizeNote(source, 'n7201', 'end', 7201.7 + step / 100);
    preview(1);
    let unrelatedWordReads = 0;
    let wordIdReads = 0;
    for (const note of source.notes) {
      const wordId = note.wordId;
      if (wordId === 'w1800') continue;
      Object.defineProperty(note, 'wordId', {
        get: () => {
          unrelatedWordReads++;
          return wordId;
        },
      });
    }
    for (const word of source.words) {
      const id = word.id;
      Object.defineProperty(word, 'id', {
        get: () => {
          wordIdReads++;
          return id;
        },
      });
    }
    for (let step = 1; step <= 30; step++) {
      const next = preview(step);
      expect(next.notes[0]).toBe(source.notes[0]);
      expect(next.notes[7999]).toBe(source.notes[7999]);
      expect(next.words).toBe(source.words);
    }
    expect.soft(unrelatedWordReads).toBe(0);
    expect.soft(wordIdReads).toBe(0);
  },
);

it('does not turn a selection of every note in one word into pairwise membership work', () => {
  const source = largeDocument();
  source.words = [{ id: 'all', text: 'voice', start: 0, end: 8001 }];
  source.notes = source.notes.map((note) => ({ ...note, wordId: 'all' }));
  const selected = new Set(source.notes.map((note) => note.id));
  const has = vi.spyOn(selected, 'has');
  const moved = moveNotes(source, selected, 2, 0.1);
  expect(has.mock.calls.length).toBeLessThan(32_000);
  expect(moved.notes[0]).toMatchObject({ pitch: 62, start: 0.3, end: 0.8 });
  expect(moved.notes.at(-1)).toMatchObject({
    pitch: 62,
    start: 7999.3,
    end: 7999.8,
  });
});

it('recomputes unselected neighbours when the selection changes within the same source document', () => {
  const source: EditorDocument = {
    revision: 1,
    words: [{ id: 'word', text: 'voice', start: 0, end: 10 }],
    notes: [
      { id: 'a', wordId: 'word', pitch: 60, start: 1, end: 2 },
      { id: 'b', wordId: 'word', pitch: 64, start: 3, end: 4 },
    ],
  };
  const preview = (ids: string[], seconds: number) =>
    moveNotes(source, new Set(ids), 0, seconds);
  expect(preview(['a'], 100).notes[0]).toMatchObject({ start: 2, end: 3 });
  expect(preview(['a', 'b'], 100).notes).toMatchObject([
    { start: 7, end: 8 },
    { start: 9, end: 10 },
  ]);
  expect(preview(['b'], -100).notes[1]).toMatchObject({ start: 2, end: 3 });
  expect(source.notes).toMatchObject([
    { start: 1, end: 2 },
    { start: 3, end: 4 },
  ]);
});

it('rebuilds groups for replacement note and word arrays and keeps immutable contours', () => {
  const contour = [
    [0, 0, 1],
    [1, 0.5, 1],
  ] as const;
  const source: EditorDocument = {
    revision: 1,
    words: [{ id: 'word', text: 'voice', start: 0, end: 10 }],
    notes: [
      { id: 'a', wordId: 'word', pitch: 60, start: 1, end: 2, contour },
      { id: 'b', wordId: 'word', pitch: 64, start: 4, end: 5 },
    ],
  };
  const resize = (document: EditorDocument) =>
    resizeNote(document, 'a', 'end', 100);
  expect(resize(source).notes[0]?.end).toBe(4);
  const movedSibling = {
    ...source,
    notes: [source.notes[0]!, { ...source.notes[1]!, wordId: 'other' }],
  };
  const first = resize(movedSibling);
  expect(first.notes[0]?.end).toBe(10);
  expect(first.notes[0]?.contour).toBe(contour);
  const shorterWord = {
    ...movedSibling,
    words: [{ ...source.words[0]!, end: 3 }],
  };
  expect(resize(shorterWord).notes[0]?.end).toBe(3);
  expect(resize(source).notes[0]?.end).toBe(4);
  expect(source.notes[0]?.end).toBe(2);
  expect(moveNotes(source, new Set(['missing']), 1, 1)).toBe(source);
  expect(resizeNote(source, 'missing', 'start', 3)).toBe(source);
});

it('preserves first-word lookup for single edits and last-word lookup for the existing large-selection path', () => {
  const source: EditorDocument = {
    revision: 1,
    words: [
      { id: 'word', text: 'first', start: 0, end: 10 },
      { id: 'word', text: 'last', start: 0, end: 20 },
    ],
    notes: Array.from({ length: 10 }, (_, index) => ({
      id: `n${index}`,
      wordId: 'word',
      pitch: 60,
      start: index + 0.2,
      end: index + 0.8,
    })),
  };
  expect(moveNotes(source, new Set(['n9']), 0, 2).notes[9]?.end).toBe(10);
  expect(resizeNote(source, 'n9', 'end', 100).notes[9]?.end).toBe(10);
  expect(
    moveNotes(source, new Set(source.notes.map((note) => note.id)), 0, 2)
      .notes[9]?.end,
  ).toBe(11.8);
});

it('preserves duplicate-note source ordering and first-match resize behavior', () => {
  const source: EditorDocument = {
    revision: 1,
    words: [
      { id: 'first', text: 'voice', start: 0, end: 10 },
      { id: 'last', text: 'voice', start: 20, end: 30 },
    ],
    notes: [
      { id: 'duplicate', wordId: 'first', pitch: 60, start: 1, end: 2 },
      { id: 'neighbour', wordId: 'first', pitch: 64, start: 4, end: 5 },
      { id: 'duplicate', wordId: 'last', pitch: 67, start: 21, end: 22 },
    ],
  };
  const moved = moveNotes(source, new Set(['duplicate']), 1, 100);
  expect(moved.notes).toMatchObject([
    { wordId: 'first', pitch: 61, start: 3, end: 4 },
    { wordId: 'first', pitch: 64, start: 4, end: 5 },
    { wordId: 'last', pitch: 68, start: 23, end: 24 },
  ]);
  expect(moved.notes[1]).toBe(source.notes[1]);
  const resized = resizeNote(source, 'duplicate', 'end', 100);
  expect(resized.notes[0]).toMatchObject({ wordId: 'first', start: 1, end: 4 });
  expect(resized.notes[2]).toBe(resized.notes[0]);
  expect(resized.notes[1]).toBe(source.notes[1]);
});
