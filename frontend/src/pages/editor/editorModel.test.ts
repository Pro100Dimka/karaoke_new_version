import { describe, expect, it } from 'vitest';
import {
  alignBoundary,
  canMerge,
  deleteNotes,
  isEditorDirty,
  mergeNotes,
  moveNotes,
  pushHistory,
  redoHistory,
  resizeNote,
  snapTime,
  startHistory,
  undoHistory,
  type EditorDocument,
} from '../../application/editor/editorModel';

const document: EditorDocument = {
  revision: 3,
  words: [
    { id: 'w1', text: 'la', start: 1, end: 3 },
    { id: 'w2', text: 'li', start: 4, end: 6 },
  ],
  notes: [
    { id: 'n1', wordId: 'w1', pitch: 60, start: 1, end: 1.8 },
    { id: 'n2', wordId: 'w1', pitch: 62, start: 2, end: 3 },
    { id: 'n3', wordId: 'w2', pitch: 64, start: 4, end: 5 },
  ],
};
const ids = (...values: string[]) => new Set(values);

describe('editor operations', () => {
  it('moves a note without letting it leave its word', () => {
    const moved = moveNotes(document, ids('n1'), 2, 5);
    expect(moved.notes[0]).toMatchObject({ pitch: 62, start: 2.2, end: 3 });
  });

  it('moves a multi-selection by the same limited shift', () => {
    const moved = moveNotes(document, ids('n1', 'n2'), 0, 5);
    expect(moved.notes[0]?.start).toBe(1);
    expect(moved.notes[1]?.end).toBe(3);
  });

  it('moves a large selection without changing independent note constraints', () => {
    const words = Array.from({ length: 20 }, (_, index) => ({
      id: `w${index}`,
      text: 'la',
      start: index,
      end: index + 1,
    }));
    const notes = words.map((word, index) => ({
      id: `n${index}`,
      wordId: word.id,
      pitch: 60,
      start: index + 0.2,
      end: index + 0.8,
    }));
    const result = moveNotes(
      { revision: 0, words, notes },
      new Set(notes.map((note) => note.id)),
      2,
      0.1,
    );
    expect(result.notes).toHaveLength(20);
    expect(result.notes[0]).toMatchObject({ pitch: 62, start: 0.3, end: 0.9 });
    expect(result.notes[19]).toMatchObject({ pitch: 62, start: 19.3, end: 19.9 });
  });

  it('resizes without crossing the opposite edge or a neighbouring note', () => {
    expect(resizeNote(document, 'n1', 'end', 2.5).notes[0]?.end).toBe(2);
    expect(resizeNote(document, 'n2', 'start', 0.1).notes[1]?.start).toBe(1.8);
    expect(resizeNote(document, 'n3', 'end', 4).notes[2]?.end).toBe(4.03);
  });

  it('merges only notes of the same word', () => {
    expect(canMerge(document, ids('n1', 'n2'))).toBe(true);
    expect(canMerge(document, ids('n1', 'n3'))).toBe(false);
    const merged = mergeNotes(document, ids('n1', 'n2'));
    expect(merged.notes).toHaveLength(2);
    expect(merged.notes[0]).toMatchObject({ id: 'n1', start: 1, end: 3 });
    expect(mergeNotes(document, ids('n1', 'n3'))).toBe(document);
  });

  it('deletes selected notes and aligns boundaries to the playhead', () => {
    expect(
      deleteNotes(document, ids('n1', 'n2')).notes.map((note) => note.id),
    ).toEqual(['n3']);
    expect(
      alignBoundary(document, ids('n3'), 'start', 4.5).notes[2]?.start,
    ).toBe(4.5);
  });

  it('batch alignment preserves sequential resize behavior across shared words', () => {
    const selected = ids('n2', 'n1');
    for (const edge of ['start', 'end'] as const) {
      const expected = [...selected].reduce(
        (current, id) => resizeNote(current, id, edge, 2.2),
        document,
      );
      expect(alignBoundary(document, selected, edge, 2.2)).toEqual(expected);
    }
  });

  it('batch alignment handles empty, missing and many selected notes', () => {
    expect(alignBoundary(document, ids(), 'start', 2)).toBe(document);
    expect(alignBoundary(document, ids('missing'), 'start', 2)).toEqual(document);
    const words = Array.from({ length: 1000 }, (_, i) => ({
      id: `w${i}`, text: 'la', start: i, end: i + 1,
    }));
    const notes = words.map((word, i) => ({
      id: `n${i}`, wordId: word.id, pitch: 60,
      start: i + 0.1, end: i + 0.9,
    }));
    const large = { revision: 0, words, notes };
    const selected = new Set(notes.filter((_, i) => i % 2 === 0).map(n => n.id));
    const aligned = alignBoundary(large, selected, 'end', 0);
    expect(aligned.notes[0]?.end).toBe(0.13);
    expect(aligned.notes[1]).toBe(notes[1]);
    expect(aligned.notes[998]?.end).toBe(998.13);
  });

  it('snaps to the grid only when enabled', () => {
    expect(snapTime(1.234, true)).toBe(1.25);
    expect(snapTime(1.234, false)).toBe(1.234);
  });
});

describe('editor history and dirty state', () => {
  it('undoes and redoes and clears redo after a new edit', () => {
    const first = startHistory(document);
    const second = pushHistory(first, deleteNotes(document, ids('n1')));
    expect(undoHistory(second).present).toBe(document);
    expect(redoHistory(undoHistory(second)).present.notes).toHaveLength(2);
    const branched = pushHistory(
      undoHistory(second),
      moveNotes(document, ids('n3'), 1, 0),
    );
    expect(branched.future).toEqual([]);
  });

  it('is dirty by content, so undoing back to the saved state is clean again', () => {
    const changed = deleteNotes(document, ids('n1'));
    expect(isEditorDirty(document, changed)).toBe(true);
    expect(isEditorDirty(document, { ...document, revision: 9 })).toBe(false);
  });

  it('detects changes to metadata and lyrics saved with the document', () => {
    for (const changed of [
      { ...document, bpm: 120 },
      { ...document, key: 'C' },
      { ...document, lyrics: 'la\nli' },
    ]) {
      expect(isEditorDirty(document, changed)).toBe(true);
    }
  });
});
